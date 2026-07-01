/**
 * Tests for the AI-citability scorer (utils/citability-audit.ts).
 *
 * The optional enrichment for the AI Visibility Funnel: when a domain has thin
 * first-party AI behavior, score how AI-READY its top pages are against four
 * equally-weighted (25 points each) signals, by fetching the real pages. It
 * never queries an LLM:
 *   1. llms.txt at the site root (one probe, shared across all pages).
 *   2. a Markdown twin of the page (/page.md, or /index.md|/llms-full.txt for /),
 *      that is real markdown and not an HTML page masquerading as .md.
 *   3. JSON-LD structured data on the page.
 *   4. clean, answer-shaped content (a real <title>, a heading, enough body text).
 *
 * getmasset.com HAS llms.txt + .md twins + JSON-LD, so a getmasset-shaped fixture
 * must score 100 (a real, true-positive result). A thin/shell page with none of
 * the signals must score 0. The domain score is the mean of the per-page scores.
 *
 * fetch is mocked per-URL so the tests are pure (no network). safeFetchText (used
 * internally) reads global.fetch and treats any non-2xx as "no body".
 */

import { auditCitability } from '../../utils/citability-audit';

/** A minimal Response-like object that safeFetchText reads (ok + text()). */
const textResponse = (body: string, ok = true, status = 200) => ({
   ok,
   status,
   statusText: ok ? 'OK' : 'Error',
   text: async () => body,
});

/** A 404-style response: ok === false, which safeFetchText treats as no body. */
const notFound = () => textResponse('', false, 404);

const LONG_BODY = 'Masset is a Marketing AI Operations company that makes your AI smarter about your business. '.repeat(8);

/** A fully AI-ready HTML page: real title, a heading, long body, and JSON-LD. */
const richHtml = (title: string) => `<!doctype html><html><head><title>${title}</title>`
   + '<script type="application/ld+json">{"@type":"WebPage","name":"x"}</script>'
   + `</head><body><h1>${title}</h1><p>${LONG_BODY}</p></body></html>`;

/** A thin shell page: no title text worth scoring, no heading, no JSON-LD, tiny body. */
const thinHtml = () => '<!doctype html><html><head></head><body><nav>menu</nav></body></html>';

afterEach(() => {
   // @ts-expect-error cleanup mock
   global.fetch = undefined;
   jest.restoreAllMocks();
});

describe('auditCitability: a fully AI-ready domain (getmasset.com shape) scores 100', () => {
   it('passes all four signals for the root page when llms.txt, an md twin, JSON-LD, and clean content all exist', async () => {
      const origin = 'https://getmasset.com';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/llms.txt`) { return textResponse('# getmasset.com\n- /pricing') as any; }
         if (url === `${origin}/`) { return textResponse(richHtml('Masset')) as any; }
         if (url === `${origin}/index.md`) { return textResponse('# Masset\n\nMarketing AI Operations.') as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('getmasset.com', []);

      expect(audit.audited).toBe(true);
      expect(audit.llmsTxtFound).toBe(true);
      const home = audit.pages.find((p) => p.path === '/');
      expect(home).toBeDefined();
      expect(home?.hasLlmsTxt).toBe(true);
      expect(home?.hasMdTwin).toBe(true);
      expect(home?.hasJsonLd).toBe(true);
      expect(home?.cleanContent).toBe(true);
      expect(home?.score).toBe(100);
      expect(audit.domainScore).toBe(100);
   });

   it('scores every provided page 100 and reports a 100 domain score for a fully-ready multi-page site', async () => {
      const origin = 'https://getmasset.com';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/llms.txt`) { return textResponse('# getmasset.com') as any; }
         if (url === `${origin}/`) { return textResponse(richHtml('Home')) as any; }
         if (url === `${origin}/index.md`) { return textResponse('# Home') as any; }
         if (url === `${origin}/pricing`) { return textResponse(richHtml('Pricing')) as any; }
         if (url === `${origin}/pricing.md`) { return textResponse('# Pricing') as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('getmasset.com', ['/pricing']);

      expect(audit.pages.map((p) => p.score)).toEqual([100, 100]);
      expect(audit.domainScore).toBe(100);
   });
});

describe('auditCitability: thin / shell pages score low', () => {
   it('scores a page 0 when no signal is present (no llms.txt, no md twin, no JSON-LD, thin body)', async () => {
      const origin = 'https://thin-site.example';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/`) { return textResponse(thinHtml()) as any; }
         // No llms.txt, no md twin.
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('thin-site.example', []);

      expect(audit.llmsTxtFound).toBe(false);
      const home = audit.pages.find((p) => p.path === '/');
      expect(home?.hasLlmsTxt).toBe(false);
      expect(home?.hasMdTwin).toBe(false);
      expect(home?.hasJsonLd).toBe(false);
      expect(home?.cleanContent).toBe(false);
      expect(home?.score).toBe(0);
      expect(audit.domainScore).toBe(0);
   });

   it('awards exactly the 25-point share for each single signal present', async () => {
      // Only JSON-LD + a title/heading/body present -> clean content + JSON-LD = 2 signals = 50.
      // No llms.txt and no md twin.
      const origin = 'https://partial.example';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/`) { return textResponse(richHtml('Partial')) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('partial.example', []);

      const home = audit.pages.find((p) => p.path === '/');
      expect(home?.hasLlmsTxt).toBe(false);
      expect(home?.hasMdTwin).toBe(false);
      expect(home?.hasJsonLd).toBe(true);
      expect(home?.cleanContent).toBe(true);
      expect(home?.score).toBe(50);
   });

   it('does not count an HTML page that masquerades as a .md twin', async () => {
      const origin = 'https://fake-twin.example';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/llms.txt`) { return notFound() as any; }
         if (url === `${origin}/`) { return textResponse(richHtml('Fake')) as any; }
         // The .md route answers with an HTML document, not real markdown.
         if (url === `${origin}/index.md`) { return textResponse('<!doctype html><html><body>not markdown</body></html>') as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('fake-twin.example', []);

      const home = audit.pages.find((p) => p.path === '/');
      // JSON-LD + clean content pass (50); the bogus md twin and missing llms.txt do not.
      expect(home?.hasMdTwin).toBe(false);
      expect(home?.score).toBe(50);
   });
});

describe('auditCitability: graceful degradation and structure', () => {
   it('never throws and degrades an unfetchable page to a recorded error rather than an exception', async () => {
      const origin = 'https://dead.example';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/llms.txt`) { return textResponse('# dead.example') as any; }
         // The page itself cannot be fetched.
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('dead.example', []);

      const home = audit.pages.find((p) => p.path === '/');
      expect(home?.error).toMatch(/could not fetch/i);
      // llms.txt was found site-wide, so the page still earns that one signal's 25 points.
      expect(home?.hasLlmsTxt).toBe(true);
      expect(home?.score).toBe(25);
   });

   it('does not throw when fetch itself rejects; the page degrades to an error result', async () => {
      const fetchMock = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('unreachable.example', []);

      const home = audit.pages.find((p) => p.path === '/');
      expect(home?.error).toMatch(/could not fetch/i);
      expect(home?.score).toBe(0);
      expect(audit.domainScore).toBe(0);
   });

   it('always includes the root, de-duplicates paths, and caps the audited set at 8 pages', async () => {
      const origin = 'https://big.example';
      // Generic 200 for every page and md twin; no llms.txt.
      const fetchMock = jest.fn(async (url: string) => {
         if (url === `${origin}/llms.txt` || url === `${origin}/llms-full.txt`) { return notFound() as any; }
         if (/\.md$/.test(url)) { return notFound() as any; }
         return textResponse(richHtml('Page')) as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // 12 paths plus duplicates and a trailing-slash dupe of the root.
      const paths = ['/', '/a', '/a', '/b/', ...Array.from({ length: 12 }, (_v, i) => `/n${i}`)];
      const audit = await auditCitability('big.example', paths);

      expect(audit.pages.length).toBeLessThanOrEqual(8);
      expect(audit.pages.some((p) => p.path === '/')).toBe(true);
      // The duplicate "/a" appears once.
      expect(audit.pages.filter((p) => p.path === '/a')).toHaveLength(1);
   });

   it('carries the explanatory note and audited flag on every result', async () => {
      const fetchMock = jest.fn(async () => notFound() as any);
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const audit = await auditCitability('whatever.example', []);

      expect(audit.audited).toBe(true);
      expect(audit.note).toMatch(/citability/i);
      expect(typeof audit.domainScore).toBe('number');
   });
});
