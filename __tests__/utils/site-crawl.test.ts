import { crawlSite, MAX_PAGES, pinnedLookup } from '../../utils/site-crawl';

/**
 * Tests for the dependency-free onboarding site crawler (utils/site-crawl.ts).
 *
 * The crawler must:
 *   - discover page URLs from sitemap.xml (including one level of sitemap-index
 *     nesting) and fall back to homepage anchor links when no sitemap exists;
 *   - extract a compact per-page summary (title, meta description, h1/h2, excerpt);
 *   - never throw, surfacing every failure (bad URL, unreachable host, dead page)
 *     as an "error" field rather than an exception;
 *   - cap the crawl at MAX_PAGES pages.
 *
 * fetch is mocked per-URL so the tests are pure (no network). Each test installs
 * its own global.fetch and tears it down afterwards.
 */

describe('pinnedLookup (SSRF IP pinning must satisfy both dns.lookup callback shapes)', () => {
   // Regression: undici calls connect.lookup with { all: true } and expects the ARRAY form. Returning
   // only the 3-arg form there fails the connection, which made the crawler reach 0 pages on real
   // Vercel/CDN hosts (e.g. getmasset.com 307-redirecting apex to www). Lock both shapes.
   type Cb = Parameters<ReturnType<typeof pinnedLookup>>[2];
   it('returns the array form [{ address, family }] when undici asks for { all: true }', () => {
      let recorded: unknown[] = [];
      const cb = ((...args: unknown[]) => { recorded = args; }) as unknown as Cb;
      pinnedLookup('64.29.17.1', 4)('www.getmasset.com', { all: true }, cb);
      expect(recorded).toEqual([null, [{ address: '64.29.17.1', family: 4 }]]);
   });

   it('returns the 3-arg (address, family) form when all is not requested', () => {
      let recorded: unknown[] = [];
      const cb = ((...args: unknown[]) => { recorded = args; }) as unknown as Cb;
      pinnedLookup('64.29.17.1', 4)('www.getmasset.com', undefined, cb);
      expect(recorded).toEqual([null, '64.29.17.1', 4]);
   });
});

/** Build a minimal Response-like object that the crawler's safeFetchText reads. */
const textResponse = (body: string, ok = true, status = 200) => ({
   ok,
   status,
   statusText: ok ? 'OK' : 'Error',
   text: async () => body,
});

/** A 404-style response (ok === false), which safeFetchText treats as "no body". */
const notFound = () => textResponse('', false, 404);

const html = (opts: { title?: string, desc?: string, h1?: string[], h2?: string[], body?: string, links?: string[] } = {}) => {
   const heads = [
      opts.title ? `<title>${opts.title}</title>` : '',
      opts.desc ? `<meta name="description" content="${opts.desc}">` : '',
   ].join('\n');
   const headings = [
      ...(opts.h1 || []).map((h) => `<h1>${h}</h1>`),
      ...(opts.h2 || []).map((h) => `<h2>${h}</h2>`),
   ].join('\n');
   const links = (opts.links || []).map((href) => `<a href="${href}">link</a>`).join('\n');
   return `<!doctype html><html><head>${heads}</head><body>${headings}${links}<p>${opts.body || 'page text'}</p></body></html>`;
};

const sitemap = (locs: string[]) => {
   const body = locs.map((l) => `<url><loc>${l}</loc></url>`).join('');
   return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
};

const sitemapIndex = (children: string[]) => {
   const body = children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('');
   return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>`;
};

describe('crawlSite', () => {
   afterEach(() => {
      // @ts-expect-error cleanup mock
      global.fetch = undefined;
      jest.restoreAllMocks();
   });

   it('returns an error result for an empty or invalid domain without fetching', async () => {
      const fetchMock = jest.fn(async () => { throw new Error('fetch should not be called for an invalid domain'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('   ');
      expect(result.pageCount).toBe(0);
      expect(result.pages).toEqual([]);
      expect(result.error).toMatch(/valid domain/i);
      expect(fetchMock).not.toHaveBeenCalled();
   });

   it('discovers pages via sitemap.xml and summarizes each page', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') {
            return textResponse(html({ title: 'Home', desc: 'The homepage', h1: ['Welcome'] })) as any;
         }
         if (url === 'https://getmasset.com/sitemap.xml') {
            return textResponse(sitemap([
               'https://getmasset.com/',
               'https://getmasset.com/pricing',
               'https://getmasset.com/software/mcp',
            ])) as any;
         }
         if (url === 'https://getmasset.com/pricing') {
            return textResponse(html({ title: 'Pricing', desc: 'Plans', h1: ['Pricing'], h2: ['Tiers'] })) as any;
         }
         if (url === 'https://getmasset.com/software/mcp') {
            return textResponse(html({ title: 'MCP', h1: ['MCP Server'] })) as any;
         }
         // sitemap_index.xml fallback candidate and anything else: 404.
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('getmasset.com');

      expect(result.error).toBeUndefined();
      expect(result.domain).toBe('getmasset.com');
      expect(result.discoveredVia).toBe('sitemap');
      expect(result.pageCount).toBe(3);

      const home = result.pages.find((p) => p.path === '/');
      expect(home).toBeDefined();
      expect(home?.title).toBe('Home');
      expect(home?.metaDescription).toBe('The homepage');
      expect(home?.h1).toContain('Welcome');

      const pricing = result.pages.find((p) => p.path === '/pricing');
      expect(pricing?.title).toBe('Pricing');
      expect(pricing?.h2).toContain('Tiers');
   });

   it('follows one level of sitemap-index nesting', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') { return textResponse(html({ title: 'Home' })) as any; }
         if (url === 'https://getmasset.com/sitemap.xml') {
            return textResponse(sitemapIndex(['https://getmasset.com/sitemap-pages.xml'])) as any;
         }
         if (url === 'https://getmasset.com/sitemap-pages.xml') {
            return textResponse(sitemap([
               'https://getmasset.com/about',
               'https://getmasset.com/blog/post-1',
            ])) as any;
         }
         if (url === 'https://getmasset.com/about') { return textResponse(html({ title: 'About' })) as any; }
         if (url === 'https://getmasset.com/blog/post-1') { return textResponse(html({ title: 'Post 1' })) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('getmasset.com');

      expect(result.discoveredVia).toBe('sitemap');
      const paths = result.pages.map((p) => p.path).sort();
      expect(paths).toEqual(['/', '/about', '/blog/post-1']);
      // The child sitemap URL itself must never end up as a crawled page.
      expect(result.pages.some((p) => /\.xml/.test(p.url))).toBe(false);
   });

   it('falls back to homepage anchor links when no sitemap is reachable', async () => {
      const homepage = html({
         title: 'Home',
         links: [
            '/features',
            '/contact',
            'https://getmasset.com/blog',
            'https://other-site.com/external',
            '/logo.png',
            '#section',
            'mailto:hi@example.com',
         ],
      });
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') { return textResponse(homepage) as any; }
         // No sitemap available.
         if (url.includes('sitemap')) { return notFound() as any; }
         if (url === 'https://getmasset.com/features') { return textResponse(html({ title: 'Features' })) as any; }
         if (url === 'https://getmasset.com/contact') { return textResponse(html({ title: 'Contact' })) as any; }
         if (url === 'https://getmasset.com/blog') { return textResponse(html({ title: 'Blog' })) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('getmasset.com');

      expect(result.discoveredVia).toBe('homepage-links');
      const paths = result.pages.map((p) => p.path).sort();
      // Same-origin links are kept; external host, asset, fragment, and mailto are dropped.
      expect(paths).toEqual(['/', '/blog', '/contact', '/features']);
      expect(result.pages.some((p) => /other-site\.com/.test(p.url))).toBe(false);
      expect(result.pages.some((p) => /\.png/.test(p.url))).toBe(false);
   });

   it('returns a homepage-only error result when the homepage is unreachable', async () => {
      const fetchMock = jest.fn(async () => notFound() as any);
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('does-not-exist.example');

      expect(result.discoveredVia).toBe('homepage-only');
      expect(result.pageCount).toBe(0);
      expect(result.pages).toEqual([]);
      expect(result.error).toMatch(/could not reach/i);
   });

   it('does not throw when fetch rejects; surfaces it as a homepage-only error', async () => {
      const fetchMock = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('unreachable.example');

      expect(result.pageCount).toBe(0);
      expect(result.error).toMatch(/could not reach/i);
   });

   it('marks an individual dead page with a per-page error but still returns the others', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') { return textResponse(html({ title: 'Home' })) as any; }
         if (url === 'https://getmasset.com/sitemap.xml') {
            return textResponse(sitemap([
               'https://getmasset.com/',
               'https://getmasset.com/good',
               'https://getmasset.com/dead',
            ])) as any;
         }
         if (url === 'https://getmasset.com/good') { return textResponse(html({ title: 'Good' })) as any; }
         if (url === 'https://getmasset.com/dead') { return notFound() as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('getmasset.com');

      expect(result.error).toBeUndefined();
      const dead = result.pages.find((p) => p.path === '/dead');
      expect(dead).toBeDefined();
      expect(dead?.error).toMatch(/could not fetch/i);
      expect(dead?.title).toBe('');

      const good = result.pages.find((p) => p.path === '/good');
      expect(good?.title).toBe('Good');
      expect(good?.error).toBeUndefined();
   });

   it('caps the number of crawled pages at MAX_PAGES', async () => {
      // Build a sitemap with far more URLs than the cap allows.
      const many = Array.from({ length: MAX_PAGES + 20 }, (_v, i) => `https://getmasset.com/p${i}`);
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') { return textResponse(html({ title: 'Home' })) as any; }
         if (url === 'https://getmasset.com/sitemap.xml') {
            return textResponse(sitemap(['https://getmasset.com/', ...many])) as any;
         }
         // Every page URL resolves to a generic page.
         return textResponse(html({ title: 'A page' })) as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('getmasset.com');

      expect(result.pageCount).toBe(MAX_PAGES);
      expect(result.pages.length).toBe(MAX_PAGES);
      // The homepage is always retained and listed first.
      expect(result.pages[0].path).toBe('/');
   });

   it('refuses to fetch loopback, private, and cloud-metadata hosts (SSRF guard)', async () => {
      // fetch must never be called for an internal target: the guard rejects the
      // host before any network call, so the result is a homepage-only error.
      const fetchMock = jest.fn(async () => { throw new Error('fetch must not run for an internal host'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const blocked = ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1', '172.16.0.1'];
      for (const target of blocked) {
         // eslint-disable-next-line no-await-in-loop
         const result = await crawlSite(target);
         expect(result.pageCount).toBe(0);
         expect(result.pages).toEqual([]);
         expect(result.error).toMatch(/could not reach/i);
      }
      expect(fetchMock).not.toHaveBeenCalled();
   });

   it('normalizes a URL or www-prefixed input down to a bare host', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://getmasset.com/') { return textResponse(html({ title: 'Home' })) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('https://www.GetMasset.com/some/path?x=1');

      expect(result.domain).toBe('getmasset.com');
      expect(result.homeUrl).toBe('https://getmasset.com/');
      // The homepage was fetched against the normalized origin.
      expect(fetchMock.mock.calls.some(([u]) => u === 'https://getmasset.com/')).toBe(true);
   });
});
