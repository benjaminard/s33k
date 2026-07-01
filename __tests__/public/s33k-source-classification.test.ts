/**
 * First-touch SOURCE classification, tested against the REAL client (public/s33k.js).
 *
 * This is the client half of conversions-by-source. The autocapture script reads
 * document.referrer ONCE at session start, reduces it to a single class
 * ('direct' | 'organic-search' | 'ai' | a bare referral host), and carries it at the top level
 * of every posted batch. The server later re-sanitizes and attributes by it.
 *
 * Rather than copy the classifier (which would let a copy drift from the shipped file), each
 * test runs the actual public/s33k.js inside a FRESH, ISOLATED jsdom window with a controlled
 * document.referrer, fills the queue past BATCH_MAX so the script flushes synchronously over
 * fetch (not the fire-and-forget beacon), and reads the `source` field off the body the script
 * POSTed to /api/collect. A new window per case means no listener stacking and no shared
 * sessionStorage, so each referrer is classified in isolation. These assertions are about the
 * code that actually ships.
 *
 * The privacy proof lives here too: a referrer with a path + query string
 * (https://news.ycombinator.com/item?id=1&email=a@b.com) must NEVER leave the browser as a
 * URL. It is either a class ('organic-search'/'ai'/'direct') or the bare referral host; the
 * path and query are never transmitted.
 */

import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

// The real shipped client. Read once; injected into a fresh window per test.
const S33K_SRC = fs.readFileSync(path.join(process.cwd(), 'public', 's33k.js'), 'utf8');

const PAGE_URL = 'https://acme.io/';

// BATCH_MAX in the client: the 10th queued event trips a synchronous fetch flush we can read.
const BATCH_MAX = 10;

// Run the real client in a brand-new jsdom window seeded with `referrer`, drive enough clicks to
// force a fetch flush, and return the parsed batch body the script POSTed. null if none.
const runClientAndCaptureSource = (referrer: string): Record<string, unknown> | null => {
   const html = '<!DOCTYPE html><html><head></head><body>'
      + '<button id="cta" type="button">Go</button></body></html>';
   // JSDOM's `referrer` option must be an absolute URL, so it cannot represent "" or a malformed
   // value. For those cases construct without it and force document.referrer afterward, which is
   // exactly what a real browser would expose to the script (an empty or junk referrer string).
   const isAbsoluteUrl = /^https?:\/\//i.test(referrer);
   const dom = new JSDOM(html, {
      url: PAGE_URL,
      ...(isAbsoluteUrl ? { referrer } : {}),
      runScripts: 'dangerously',
      pretendToBeVisual: true,
   });
   const { window } = dom;
   if (!isAbsoluteUrl) {
      Object.defineProperty(window.document, 'referrer', { value: referrer, configurable: true });
   }

   const sent: Record<string, unknown>[] = [];
   // Inject a fetch that captures the POST body synchronously, plus a no-op sendBeacon so the
   // script's beacon path (final flush) never throws.
   (window as unknown as { fetch: unknown }).fetch = (_url: string, init?: { body?: string }) => {
      if (init && typeof init.body === 'string') { sent.push(JSON.parse(init.body)); }
      return Promise.resolve({ ok: true });
   };
   (window.navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => true;

   // The script reads document.currentScript / a <script src=...s33k.js> tag for its data-domain
   // and data-host config. Add the tag, then eval the source as that script's body.
   const tag = window.document.createElement('script');
   tag.setAttribute('src', `${PAGE_URL}s33k.js`);
   tag.setAttribute('data-domain', 'acme.io');
   tag.setAttribute('data-host', 'https://acme.io');
   window.document.body.appendChild(tag);

   // Run the real IIFE in this window's global scope so document/window/navigator resolve to it.
   window.eval(S33K_SRC);

   const cta = window.document.getElementById('cta') as HTMLButtonElement;
   for (let i = 0; i < BATCH_MAX; i += 1) {
      cta.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
   }

   dom.window.close();
   // The first POSTed batch is the click batch; its source is the classified session source.
   return sent[0] || null;
};

describe('public/s33k.js classifySource: the four classes', () => {
   it('classifies no referrer as direct', () => {
      const body = runClientAndCaptureSource('');
      expect(body).not.toBeNull();
      expect(body?.source).toBe('direct');
   });

   it('classifies a same-origin referrer as direct (in-site navigation, not a source)', () => {
      const body = runClientAndCaptureSource(`${PAGE_URL}pricing`);
      expect(body?.source).toBe('direct');
   });

   it('classifies a known search engine as organic-search', () => {
      expect(runClientAndCaptureSource('https://www.google.com/search?q=acme')?.source).toBe('organic-search');
      expect(runClientAndCaptureSource('https://www.bing.com/search?q=acme')?.source).toBe('organic-search');
      expect(runClientAndCaptureSource('https://duckduckgo.com/?q=acme')?.source).toBe('organic-search');
   });

   it('classifies a known AI engine as ai', () => {
      expect(runClientAndCaptureSource('https://chatgpt.com/')?.source).toBe('ai');
      expect(runClientAndCaptureSource('https://www.perplexity.ai/search/foo')?.source).toBe('ai');
      expect(runClientAndCaptureSource('https://claude.ai/chat/123')?.source).toBe('ai');
   });

   it('classifies an unknown external site as the bare referral host only', () => {
      const body = runClientAndCaptureSource('https://news.ycombinator.com/');
      // A referral becomes the bare host, never the class word, never a path.
      expect(body?.source).toBe('news.ycombinator.com');
   });
});

describe('public/s33k.js classifySource: the privacy proof (no URL/PII ever leaves the browser)', () => {
   it('NEVER sends a path or query string: a deep referral URL becomes the bare host', () => {
      const body = runClientAndCaptureSource('https://news.ycombinator.com/item?id=1&email=a@b.com');
      const source = String(body?.source ?? '');
      // The host is allowed; the path, the query, and the email in it are not.
      expect(source).toBe('news.ycombinator.com');
      expect(source).not.toContain('/');
      expect(source).not.toContain('?');
      expect(source).not.toContain('email');
      expect(source).not.toContain('a@b.com');
   });

   it('a search referrer with a PII-bearing query is reduced to the organic-search class', () => {
      const body = runClientAndCaptureSource('https://www.google.com/search?q=acme&email=a@b.com');
      const source = String(body?.source ?? '');
      expect(source).toBe('organic-search');
      expect(source).not.toContain('email');
      expect(source).not.toContain('?');
   });

   it('an unparseable referrer falls back to direct, never throwing', () => {
      const body = runClientAndCaptureSource('not-a-url');
      expect(body?.source).toBe('direct');
   });
});
