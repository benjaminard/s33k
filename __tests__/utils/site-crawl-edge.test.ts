import { crawlSite, MAX_PAGES } from '../../utils/site-crawl';

/**
 * Additional edge-case coverage for the onboarding site crawler
 * (utils/site-crawl.ts), complementing __tests__/utils/site-crawl.test.ts.
 *
 * These tests pin behaviors the first suite does not exercise:
 *   - HTML-entity decoding inside titles, meta descriptions, and excerpts.
 *   - The og:description fallback when no name="description" meta exists.
 *   - prioritize() pruning of non-content paths (wp-admin, feed, tag, category,
 *     author) and its shortest-path-first ordering.
 *   - de-duplication of homepage links that differ only by query string or
 *     trailing slash.
 *   - rejection of non-http(s) schemes by the SSRF/scheme guard (the homepage
 *     never gets fetched, so the result is a homepage-only error).
 *   - script/style/comment stripping so their contents never leak into excerpts.
 *
 * fetch is mocked per-URL so every test is pure (no network).
 */

const textResponse = (body: string, ok = true, status = 200) => ({
   ok,
   status,
   statusText: ok ? 'OK' : 'Error',
   text: async () => body,
});

const notFound = () => textResponse('', false, 404);

const sitemap = (locs: string[]) => {
   const body = locs.map((l) => `<url><loc>${l}</loc></url>`).join('');
   return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
};

describe('crawlSite edge cases', () => {
   afterEach(() => {
      // @ts-expect-error cleanup mock
      global.fetch = undefined;
      jest.restoreAllMocks();
   });

   it('decodes HTML entities in title, meta description, and excerpt', async () => {
      const page = '<!doctype html><html><head>'
         + '<title>Tom &amp; Jerry &#8212; the &quot;best&quot;</title>'
         + '<meta name="description" content="Sales &lt;b&gt;tips&lt;/b&gt; &#38; tricks">'
         + '</head><body><h1>Pricing &#x2013; Plans</h1><p>Save 50&#37; today &amp; tomorrow</p></body></html>';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse(page) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('example.com');
      const home = result.pages.find((p) => p.path === '/');

      expect(home?.title).toContain('Tom & Jerry');
      expect(home?.title).toContain('"best"');
      expect(home?.metaDescription).toContain('<b>tips</b>');
      expect(home?.metaDescription).toContain('& tricks');
      expect(home?.h1.join(' ')).toContain('Pricing');
      expect(home?.excerpt).toContain('Save 50% today & tomorrow');
   });

   it('falls back to og:description when no name="description" meta is present', async () => {
      const page = '<!doctype html><html><head><title>OG Page</title>'
         + '<meta property="og:description" content="Open Graph summary text">'
         + '</head><body><p>body</p></body></html>';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse(page) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('example.com');
      const home = result.pages.find((p) => p.path === '/');
      expect(home?.metaDescription).toBe('Open Graph summary text');
   });

   it('never leaks <script>/<style>/comment contents into the excerpt', async () => {
      const page = '<!doctype html><html><head><title>Clean</title></head><body>'
         + '<script>window.SECRET_TOKEN = "leak-me";</script>'
         + '<style>.x{color:#abcdef}</style>'
         + '<!-- internal-comment-do-not-show -->'
         + '<p>Visible body copy.</p></body></html>';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse(page) as any; }
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('example.com');
      const home = result.pages.find((p) => p.path === '/');
      expect(home?.excerpt).toContain('Visible body copy.');
      expect(home?.excerpt).not.toContain('SECRET_TOKEN');
      expect(home?.excerpt).not.toContain('color');
      expect(home?.excerpt).not.toContain('internal-comment');
   });

   it('prunes non-content paths (wp-admin, feed, tag, category, author) from the sitemap', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://blog.example/') { return textResponse('<title>Home</title>') as any; }
         if (url === 'https://blog.example/sitemap.xml') {
            return textResponse(sitemap([
               'https://blog.example/',
               'https://blog.example/about',
               'https://blog.example/wp-admin/options.php',
               'https://blog.example/feed',
               'https://blog.example/tag/seo',
               'https://blog.example/category/news',
               'https://blog.example/author/ben',
            ])) as any;
         }
         return textResponse('<title>A page</title>') as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('blog.example');
      const paths = result.pages.map((p) => p.path).sort();
      expect(paths).toEqual(['/', '/about']);
      expect(result.pages.some((p) => /wp-admin|feed|tag|category|author/.test(p.url))).toBe(false);
   });

   it('orders discovered pages shortest-path-first after the homepage', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse('<title>Home</title>') as any; }
         if (url === 'https://example.com/sitemap.xml') {
            return textResponse(sitemap([
               'https://example.com/a/b/c/deep',
               'https://example.com/x',
               'https://example.com/a/mid',
               'https://example.com/',
            ])) as any;
         }
         return textResponse('<title>page</title>') as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('example.com');
      const paths = result.pages.map((p) => p.path);
      // Homepage is always first; the rest are sorted by depth (number of slashes)
      // then length, so /x precedes /a/mid precedes /a/b/c/deep.
      expect(paths[0]).toBe('/');
      expect(paths.indexOf('/x')).toBeLessThan(paths.indexOf('/a/mid'));
      expect(paths.indexOf('/a/mid')).toBeLessThan(paths.indexOf('/a/b/c/deep'));
   });

   it('de-duplicates homepage links that differ only by query string or trailing slash', async () => {
      const homepage = '<!doctype html><html><head><title>Home</title></head><body>'
         + '<a href="/pricing">a</a>'
         + '<a href="/pricing?utm_source=nav">b</a>'
         + '<a href="/pricing#cta">c</a>'
         + '<a href="https://example.com/about">d</a>'
         + '<a href="https://www.example.com/about">e</a>'
         + '</body></html>';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse(homepage) as any; }
         if (url.includes('sitemap')) { return notFound() as any; }
         return textResponse('<title>page</title>') as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('example.com');
      expect(result.discoveredVia).toBe('homepage-links');
      const paths = result.pages.map((p) => p.path).sort();
      // /pricing appears once despite three link variants; /about once despite www variant.
      expect(paths).toEqual(['/', '/about', '/pricing']);
      expect(paths.filter((p) => p === '/pricing').length).toBe(1);
   });

   it('blocks additional SSRF host classes not covered elsewhere (0.0.0.0, CGNAT, IPv6 ULA, .localhost)', async () => {
      const fetchMock = jest.fn(async () => { throw new Error('fetch must not run for an internal host'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // 0.0.0.0 (unspecified), 100.64.0.1 (carrier-grade NAT), fd00:: (IPv6
      // unique-local), and a *.localhost name are each blocked by a distinct
      // branch of the guard before any network call.
      const blocked = ['0.0.0.0', '100.64.0.1', 'fd00::1', 'app.localhost'];
      for (const target of blocked) {
         // eslint-disable-next-line no-await-in-loop
         const result = await crawlSite(target);
         expect(result.pageCount).toBe(0);
         expect(result.error).toMatch(/could not reach/i);
      }
      expect(fetchMock).not.toHaveBeenCalled();
   });

   it('treats a sitemap that returns only child-sitemap entries with no pages as empty and falls back', async () => {
      // A sitemap index whose child sitemaps are all unreachable yields zero pages,
      // so the crawler must fall back to homepage links rather than returning empty.
      const homepage = '<!doctype html><html><head><title>Home</title></head><body>'
         + '<a href="/only-link">x</a></body></html>';
      const fetchMock = jest.fn(async (url: string) => {
         if (url === 'https://example.com/') { return textResponse(homepage) as any; }
         if (url === 'https://example.com/sitemap.xml') {
            return textResponse(
               '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
               + '<sitemap><loc>https://example.com/dead-child.xml</loc></sitemap></sitemapindex>',
            ) as any;
         }
         // The child sitemap is unreachable, and so is sitemap_index.xml.
         return notFound() as any;
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const result = await crawlSite('example.com');
      expect(result.discoveredVia).toBe('homepage-links');
      const paths = result.pages.map((p) => p.path).sort();
      expect(paths).toEqual(['/', '/only-link']);
   });

   it('exposes a MAX_PAGES cap of 25', () => {
      expect(MAX_PAGES).toBe(25);
   });
});
