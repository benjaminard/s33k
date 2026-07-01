/**
 * Unit tests for utils/firecrawl.ts (the onboarding keyword-recommendation client).
 *
 * Firecrawl HTTP is mocked via global.fetch. We assert: it no-ops cleanly when unconfigured; it
 * normalizes/dedupes/caps the extracted keywords and path-normalizes target pages; it falls back to
 * the homepage when /map is unavailable; and it never throws on a failed start, returning an error so
 * onboarding can fall back to the heuristic.
 */

const ORIGINAL_ENV = { ...process.env };
const realFetch = global.fetch;

const jsonResponse = (body: unknown, ok = true): Response => ({
   ok,
   status: ok ? 200 : 500,
   json: async () => body,
   text: async () => JSON.stringify(body),
} as unknown as Response);

afterEach(() => { process.env = { ...ORIGINAL_ENV }; global.fetch = realFetch; jest.resetModules(); });

// Load the module fresh each test so firecrawlConfigured reads the per-test env.
const loadModule = async () => {
   let mod: typeof import('../../utils/firecrawl');
   await jest.isolateModulesAsync(async () => { mod = await import('../../utils/firecrawl'); });
   // @ts-expect-error assigned inside isolateModulesAsync
   return mod;
};

describe('utils/firecrawl', () => {
   it('firecrawlConfigured reflects the env key', async () => {
      process.env.FIRECRAWL_API_KEY = '';
      let mod = await loadModule();
      expect(mod.firecrawlConfigured()).toBe(false);
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';
      mod = await loadModule();
      expect(mod.firecrawlConfigured()).toBe(true);
   });

   it('returns an error (no throw) when unconfigured, so onboarding falls back', async () => {
      process.env.FIRECRAWL_API_KEY = '';
      const mod = await loadModule();
      const result = await mod.extractKeywords('getmasset.com');
      expect(result.keywords).toEqual([]);
      expect(result.error).toBeTruthy();
   });

   it('normalizes, dedupes, path-normalizes, and caps the extracted keywords (inline data path)', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';
      // map returns links; extract returns inline data (no job id) with messy + duplicate + 60 entries.
      const manyKeywords = Array.from({ length: 60 }, (_v, i) => ({ keyword: `Keyword Phrase ${i}`, targetPage: `https://getmasset.com/p${i}` }));
      const extractData = {
         businessName: 'Masset',
         keywords: [
            { keyword: '  AI Content Management  ', targetPage: '/software' },
            { keyword: 'ai content management', targetPage: '/dup' }, // duplicate (case/space) -> dropped
            { keyword: 'dam for marketing', targetPage: 'https://getmasset.com/dam?x=1' }, // url -> path
            ...manyKeywords,
         ],
      };
      global.fetch = jest.fn(async (url: string) => {
         if (String(url).includes('/map')) { return jsonResponse({ success: true, links: ['https://getmasset.com/software', 'https://getmasset.com/dam'] }); }
         if (String(url).includes('/extract')) { return jsonResponse({ success: true, data: extractData }); }
         return jsonResponse({}, false);
      }) as unknown as typeof fetch;

      const mod = await loadModule();
      const result = await mod.extractKeywords('getmasset.com');
      expect(result.businessName).toBe('Masset');
      expect(result.keywords.length).toBe(50); // capped at MAX_KEYWORDS
      // first entry normalized (lowercased, trimmed) and its target page kept as a path
      expect(result.keywords[0]).toEqual({ keyword: 'ai content management', targetPage: '/software' });
      // the case/space duplicate did not produce a second entry
      expect(result.keywords.filter((k) => k.keyword === 'ai content management').length).toBe(1);
      // a full URL target page was reduced to its path
      const dam = result.keywords.find((k) => k.keyword === 'dam for marketing');
      expect(dam && dam.targetPage).toBe('/dam');
   });

   it('still runs extract on the homepage when /map is unavailable', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';
      let extractBody: any = null;
      global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
         if (String(url).includes('/map')) { return jsonResponse({}, false); } // map fails
         if (String(url).includes('/extract')) {
            extractBody = JSON.parse(String(init?.body || '{}'));
            return jsonResponse({ success: true, data: { businessName: 'X', keywords: [{ keyword: 'one keyword', targetPage: '/' }] } });
         }
         return jsonResponse({}, false);
      }) as unknown as typeof fetch;

      const mod = await loadModule();
      const result = await mod.extractKeywords('getmasset.com');
      expect(result.keywords.length).toBe(1);
      // map failed, so the pillar set is just the homepage
      expect(extractBody.urls).toEqual(['https://getmasset.com']);
   });

   it('returns the scraped pillar pages (the crawl) alongside the keywords on success', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';
      global.fetch = jest.fn(async (url: string) => {
         if (String(url).includes('/map')) { return jsonResponse({ success: true, links: ['https://getmasset.com/software'] }); }
         if (String(url).includes('/scrape')) {
            return jsonResponse({ success: true, data: { markdown: 'Masset is AI-ready DAM software for marketing teams.', metadata: { title: 'Masset' } } });
         }
         if (String(url).includes('/extract')) { return jsonResponse({ success: true, data: { businessName: 'Masset', keywords: [{ keyword: 'ai-ready dam', targetPage: '/' }] } }); }
         return jsonResponse({}, false);
      }) as unknown as typeof fetch;

      const mod = await loadModule();
      const result = await mod.extractKeywords('getmasset.com');
      expect(result.keywords.length).toBe(1);
      expect(Array.isArray(result.pages)).toBe(true);
      expect((result.pages || []).length).toBeGreaterThan(0);
      expect((result.pages || [])[0]).toEqual(expect.objectContaining({ title: 'Masset', text: expect.stringContaining('AI-ready DAM software') }));
   });

   it('returns an error (no throw) when the extract start fails', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';
      global.fetch = jest.fn(async (url: string) => {
         if (String(url).includes('/map')) { return jsonResponse({ success: true, links: [] }); }
         return jsonResponse({ error: 'boom' }, false); // extract POST fails
      }) as unknown as typeof fetch;

      const mod = await loadModule();
      const result = await mod.extractKeywords('getmasset.com');
      expect(result.keywords).toEqual([]);
      expect(result.error).toBeTruthy();
   });
});
