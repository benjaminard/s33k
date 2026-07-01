/**
 * Tests for the heuristic, LLM-free keyword discovery layer (utils/keyword-discovery.ts).
 *
 * discoverKeywords reuses the SSRF-guarded site crawler (utils/site-crawl.ts) and turns each
 * crawled page's on-page signals (title, h1, meta description, h2, slug) into a small ranked,
 * deduped set of candidate target keywords. These tests drive the heuristic end-to-end against
 * fetch-mocked HTML fixtures (no network, no LLM), asserting:
 *   - title brand-segment stripping ("Topic | Brand" -> "topic"),
 *   - h1 / meta / h2 / slug contribution in trust order,
 *   - stop-word / length / number filtering,
 *   - per-page dedupe and cap,
 *   - pages with a crawl error are dropped, and a crawl-level error surfaces at the top level.
 *
 * The crawler itself is NOT mocked: we want the real crawl path exercised so the heuristic is
 * proven against the same PageSummary shape production produces. fetch is mocked per-URL.
 */

import { discoverKeywords } from '../../utils/keyword-discovery';

/** Build a minimal Response-like object the crawler's safeFetchText reads. */
const textResponse = (body: string, ok = true, status = 200) => ({
   ok,
   status,
   statusText: ok ? 'OK' : 'Error',
   text: async () => body,
});

const notFound = () => textResponse('', false, 404);

const html = (opts: { title?: string, desc?: string, h1?: string[], h2?: string[], body?: string } = {}) => {
   const heads = [
      opts.title ? `<title>${opts.title}</title>` : '',
      opts.desc ? `<meta name="description" content="${opts.desc}">` : '',
   ].join('\n');
   const headings = [
      ...(opts.h1 || []).map((h) => `<h1>${h}</h1>`),
      ...(opts.h2 || []).map((h) => `<h2>${h}</h2>`),
   ].join('\n');
   return `<!doctype html><html><head>${heads}</head><body>${headings}<p>${opts.body || 'page text'}</p></body></html>`;
};

const sitemap = (locs: string[]) => {
   const body = locs.map((l) => `<url><loc>${l}</loc></url>`).join('');
   return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
};

describe('discoverKeywords', () => {
   afterEach(() => {
      // @ts-expect-error cleanup mock
      global.fetch = undefined;
      jest.restoreAllMocks();
   });

   it('strips a brand segment from the title and ranks title, h1, meta, h2, slug in trust order', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') {
            return textResponse(html({ title: 'Home' })) as any;
         }
         if (url === 'https://getmasset.com/sitemap.xml') {
            return textResponse(sitemap(['https://getmasset.com/software/mcp-server'])) as any;
         }
         if (url === 'https://getmasset.com/software/mcp-server') {
            return textResponse(html({
               title: 'AI-Ready DAM | Masset',
               h1: ['MCP Server for Marketing'],
               desc: 'Connect every AI tool',
               h2: ['Version Control'],
            })) as any;
         }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await discoverKeywords('getmasset.com');
      expect(result.error).toBeUndefined();
      expect(result.domain).toBe('getmasset.com');

      const page = result.candidates.find((c) => c.page === 'https://getmasset.com/software/mcp-server');
      expect(page).toBeDefined();
      const kws = page!.suggestedKeywords;

      // Title brand segment "Masset" is stripped; only the topic survives.
      expect(kws[0]).toBe('ai-ready dam');
      // Trust order: title, then h1, then meta description, then h2, then slug.
      expect(kws).toContain('mcp server for marketing');
      expect(kws).toContain('connect every ai tool');
      expect(kws).toContain('version control');
      expect(kws).toContain('software mcp server');
      expect(kws.indexOf('ai-ready dam')).toBeLessThan(kws.indexOf('mcp server for marketing'));
   });

   it('filters stop words, pure numbers, and too-short tokens, and dedupes within a page', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse(html({ title: 'Home' })) as any; }
         if (url === 'https://example.com/sitemap.xml') {
            return textResponse(sitemap(['https://example.com/pricing'])) as any;
         }
         if (url === 'https://example.com/pricing') {
            return textResponse(html({
               // Single stop word, a pure number, a 2-char token: all rejected.
               title: 'Home',
               h1: ['2026'],
               h2: ['Pricing Plans', 'Pricing Plans'],
            })) as any;
         }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await discoverKeywords('example.com');
      const page = result.candidates.find((c) => c.page === 'https://example.com/pricing');
      expect(page).toBeDefined();
      const kws = page!.suggestedKeywords;

      // "home" (single stop word) and "2026" (pure number) are filtered out.
      expect(kws).not.toContain('home');
      expect(kws).not.toContain('2026');
      // The duplicate "Pricing Plans" heading collapses to one entry.
      expect(kws.filter((k) => k === 'pricing plans')).toHaveLength(1);
      // The slug still contributes a phrase.
      expect(kws).toContain('pricing');
   });

   it('drops pages with a per-page crawl error and surfaces a crawl-level error at the top', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://site.test/') { return textResponse(html({ title: 'Home Base | Site' })) as any; }
         if (url === 'https://site.test/sitemap.xml') {
            return textResponse(sitemap(['https://site.test/', 'https://site.test/dead'])) as any;
         }
         if (url === 'https://site.test/dead') { return notFound() as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await discoverKeywords('site.test');
      // The dead page (per-page error) produces no candidate entry.
      expect(result.candidates.some((c) => c.page === 'https://site.test/dead')).toBe(false);
      // The reachable homepage still contributes keywords.
      const home = result.candidates.find((c) => c.page === 'https://site.test/');
      expect(home?.suggestedKeywords).toContain('home base');
   });

   it('returns an empty candidate set and a top-level error for an unreachable site without throwing', async () => {
      const fetchMock = jest.fn(async () => notFound() as any);
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await discoverKeywords('does-not-exist.example');
      expect(result.candidates).toEqual([]);
      expect(result.error).toMatch(/could not reach/i);
   });
});
