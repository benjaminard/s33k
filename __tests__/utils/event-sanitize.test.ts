/**
 * Tests for utils/event-sanitize.ts: the server-side PII defense-in-depth for autocaptured
 * engagement events. These tests are the concrete proof of the non-negotiable privacy
 * guarantee: an event that carries PII (or a smuggled typed value) is DROPPED, never stored;
 * a clean event is sanitized, truncated, and bounded.
 */

import {
   sanitizeEvent,
   sanitizeBatch,
   sanitizeText,
   sanitizeSession,
   sanitizeSource,
   looksLikePII,
   cleanEventPath,
   MAX_LABEL_LEN,
} from '../../utils/event-sanitize';

describe('sanitizeEvent: valid events', () => {
   it('keeps a clean click with label + selector', () => {
      const out = sanitizeEvent({ type: 'click', page: '/pricing', label: 'Start free trial', selector: 'a.cta' });
      expect(out).toEqual({
         type: 'click', page: '/pricing', label: 'Start free trial', selector: 'a.cta', value: null, source: 'direct',
      });
   });

   it('clamps scroll value to 0..100 and keeps it only for scroll', () => {
      expect(sanitizeEvent({ type: 'scroll', page: '/', value: 250 })!.value).toBe(100);
      expect(sanitizeEvent({ type: 'scroll', page: '/', value: -5 })!.value).toBe(0);
      // value is ignored (null) for click.
      expect(sanitizeEvent({ type: 'click', page: '/', label: 'x', value: 80 })!.value).toBeNull();
   });

   it('clamps engagement seconds to 0..86400', () => {
      expect(sanitizeEvent({ type: 'engagement', page: '/', value: 999999 })!.value).toBe(86400);
      expect(sanitizeEvent({ type: 'engagement', page: '/', value: 42 })!.value).toBe(42);
   });

   it('strips query and hash from the page path', () => {
      const out = sanitizeEvent({ type: 'click', page: 'https://x.com/account?email=a@b.com#tok', label: 'Go' });
      expect(out!.page).toBe('/account');
   });
});

describe('sanitizeEvent: PII defense (the privacy proof)', () => {
   it('DROPS an event whose label contains an email (smuggled input value)', () => {
      expect(sanitizeEvent({ type: 'form_submit', page: '/signup', label: 'jane.doe@example.com' })).toBeNull();
   });

   it('DROPS an event whose label looks like a credit-card number', () => {
      expect(sanitizeEvent({ type: 'click', page: '/pay', label: '4111 1111 1111 1111' })).toBeNull();
   });

   it('DROPS an event whose label looks like an SSN or a phone number', () => {
      expect(sanitizeEvent({ type: 'click', page: '/', label: '123-45-6789' })).toBeNull();
      expect(sanitizeEvent({ type: 'click', page: '/', label: '+1 (415) 555-2671' })).toBeNull();
   });

   it('DROPS an event whose SELECTOR carries PII', () => {
      expect(sanitizeEvent({ type: 'click', page: '/', label: 'Submit', selector: 'input[value=a@b.com]' })).toBeNull();
   });

   it('rejects an unknown event type', () => {
      expect(sanitizeEvent({ type: 'keystroke', page: '/', label: 'secret' } as never)).toBeNull();
      expect(sanitizeEvent({} as never)).toBeNull();
   });
});

describe('sanitizeText / helpers', () => {
   it('collapses whitespace and truncates to max', () => {
      const long = 'a'.repeat(MAX_LABEL_LEN + 50);
      expect(sanitizeText(long, MAX_LABEL_LEN).length).toBe(MAX_LABEL_LEN);
      expect(sanitizeText('  hello   world  ', 100)).toBe('hello world');
   });

   it('looksLikePII flags emails but not ordinary button text', () => {
      expect(looksLikePII('contact@acme.io')).toBe(true);
      expect(looksLikePII('Add to cart')).toBe(false);
   });

   it('cleanEventPath reduces a full URL to a leading-slash path', () => {
      expect(cleanEventPath('https://acme.io/features/x?utm=1')).toBe('/features/x');
      expect(cleanEventPath('relative/page')).toBe('/relative/page');
      expect(cleanEventPath(123 as never)).toBe('/123');
   });

   it('sanitizeSession keeps only safe token chars', () => {
      expect(sanitizeSession('abc-123_XYZ')).toBe('abc-123_XYZ');
      expect(sanitizeSession('drop these spaces!@#')).toBe('dropthesespaces');
   });
});

describe('sanitizeSource: the source-privacy proof', () => {
   it('keeps each of the four allowed class labels', () => {
      expect(sanitizeSource('direct')).toBe('direct');
      expect(sanitizeSource('referral')).toBe('referral');
      expect(sanitizeSource('organic-search')).toBe('organic-search');
      expect(sanitizeSource('ai')).toBe('ai');
      expect(sanitizeSource('AI')).toBe('ai'); // case-insensitive
   });

   it('keeps a bare referrer host (no path/query)', () => {
      expect(sanitizeSource('news.ycombinator.com')).toBe('news.ycombinator.com');
      expect(sanitizeSource('t.co')).toBe('t.co');
   });

   it('DROPS anything URL-like to direct (never stores a full referrer URL or query)', () => {
      // A full URL with a path/query could carry PII like ?email=...; it must never be stored.
      expect(sanitizeSource('https://news.ycombinator.com/item?id=1&email=a@b.com')).toBe('direct');
      expect(sanitizeSource('news.ycombinator.com/item?id=1')).toBe('direct');
      expect(sanitizeSource('http://evil.com/?token=secret')).toBe('direct');
      expect(sanitizeSource('user@example.com')).toBe('direct');
      expect(sanitizeSource('not a host with spaces')).toBe('direct');
   });

   it('defaults missing/blank/garbage to direct', () => {
      expect(sanitizeSource(undefined)).toBe('direct');
      expect(sanitizeSource('')).toBe('direct');
      expect(sanitizeSource(123 as never)).toBe('direct');
      expect(sanitizeSource('   ')).toBe('direct');
   });

   it('stamps the session source on every clean event in a batch', () => {
      const out = sanitizeBatch(
         [{ type: 'form_submit', page: '/signup', label: 'signup' }, { type: 'click', page: '/', label: 'Go' }],
         50,
         'organic-search',
      );
      expect(out.every((e) => e.source === 'organic-search')).toBe(true);
   });

   it('downgrades a URL-like batch source to direct on every event', () => {
      const out = sanitizeBatch([{ type: 'click', page: '/', label: 'Go' }], 50, 'https://x.com/a?q=pii');
      expect(out[0].source).toBe('direct');
   });
});

describe('sanitizeBatch', () => {
   it('drops invalid/PII events and keeps clean ones, capped at maxBatch', () => {
      const events = [
         { type: 'click', page: '/', label: 'Buy now', selector: 'button' },
         { type: 'form_submit', page: '/', label: 'leaked@pii.com' }, // dropped
         { type: 'nope', page: '/', label: 'x' }, // dropped
         { type: 'scroll', page: '/', value: 75 },
      ];
      const out = sanitizeBatch(events);
      expect(out.map((e) => e.type)).toEqual(['click', 'scroll']);
   });

   it('returns [] for a non-array input', () => {
      expect(sanitizeBatch('nope' as never)).toEqual([]);
      expect(sanitizeBatch(undefined)).toEqual([]);
   });

   it('caps the number of events processed', () => {
      const many = Array.from({ length: 100 }, () => ({ type: 'click', page: '/', label: 'x' }));
      expect(sanitizeBatch(many, 50).length).toBe(50);
   });
});
