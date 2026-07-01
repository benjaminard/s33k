/**
 * Route-level tests for the guided onboarding orchestrator (pages/api/onboard.ts).
 *
 * The onboard endpoint is the one-call, one-input (domain) setup path. These tests assert the
 * orchestration contract end-to-end with every side-effecting dependency mocked:
 *   1. It creates the domain owner-stamped via the multi-tenant pattern (ownerIdFor), or reuses
 *      an existing owned row instead of creating a duplicate.
 *   2. It feeds heuristic discovery output into Keyword.bulkCreate, capped at the onboard max,
 *      globally deduped, each keyword owner-stamped and mapped to its page's target_page, and
 *      kicks off the background SERP refresh (not awaited).
 *   3. It returns the s33k.js beacon install snippet + guides. The first-party beacon keys every
 *      event by domain, so the site id IS the domain: there is nothing to provision.
 *
 * The DB layer is a no-op sync; the Domain/Keyword models, authorize, refresh, parseKeywords,
 * settings, and keyword-discovery are mocked. install-guides runs for real (pure product
 * knowledge) so the returned snippet shape is genuinely exercised. No network.
 *
 * The scope helpers (ownerIdFor / scopeWhere) are NOT mocked: the real flag-gated logic is
 * threaded through the real route so owner stamping is proven, not re-asserted.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findOne: jest.fn(), create: jest.fn(), count: jest.fn() },
}));
jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: { bulkCreate: jest.fn(), count: jest.fn(async () => 0) },
}));
// Firecrawl is OFF by default for the existing cases, so onboarding uses the heuristic discovery
// path they assert. The dedicated "Firecrawl recommendation" block below overrides per-test.
jest.mock('../../utils/firecrawl', () => ({
   __esModule: true,
   firecrawlConfigured: jest.fn(() => false),
   extractKeywords: jest.fn(async () => ({ businessName: '', keywords: [], error: 'Firecrawl is not configured.' })),
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
jest.mock('../../utils/parseKeywords', () => ({ __esModule: true, default: jest.fn((rows: unknown[]) => rows) }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper', scaping_api: 'k' })) }));
jest.mock('../../utils/keyword-discovery', () => ({ __esModule: true, discoverKeywords: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import onboardHandler from '../../pages/api/onboard';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import refreshFn from '../../utils/refresh';
// eslint-disable-next-line import/first
import { discoverKeywords } from '../../utils/keyword-discovery';
// eslint-disable-next-line import/first
import { getAppSettings } from '../../pages/api/settings';
// eslint-disable-next-line import/first
import { firecrawlConfigured, extractKeywords } from '../../utils/firecrawl';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockSettings = getAppSettings as unknown as jest.Mock;
const mockDomain = DomainModel as unknown as { findOne: jest.Mock, create: jest.Mock, count: jest.Mock };
const mockKeyword = KeywordModel as unknown as { bulkCreate: jest.Mock, count: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockRefresh = refreshFn as unknown as jest.Mock;
const mockDiscover = discoverKeywords as unknown as jest.Mock;
const mockFirecrawlConfigured = firecrawlConfigured as unknown as jest.Mock;
const mockExtract = extractKeywords as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

/** A Domain row stand-in: update() records the patch and mutates the row. */
const domainRow = (data: Record<string, unknown>) => {
   const r: Record<string, unknown> = { ...data };
   r.update = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(r, patch); return r; });
   return r;
};

/** A Keyword row stand-in: get({plain}) returns the flat data. */
const keywordRow = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (opts: { method?: string, body?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body || {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, any> };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   process.env = { ...ORIGINAL_ENV };
   process.env.S33K_BEACON_HOST = 'https://analytics.example.com';
   asCaller(ADMIN);
   mockDiscover.mockResolvedValue({ domain: 'getmasset.com', candidates: [] });
   mockDomain.count.mockResolvedValue(0);
   mockSettings.mockResolvedValue({ scraper_type: 'serper', scaping_api: 'k' });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/onboard happy path', () => {
   it('creates the domain, adds discovered keywords, and returns the beacon snippet + guides', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const row = domainRow({ ID: 10, domain: 'getmasset.com' });
      mockDomain.create.mockResolvedValue(row);
      mockDiscover.mockResolvedValue({
         domain: 'getmasset.com',
         candidates: [
            { page: 'https://getmasset.com/', suggestedKeywords: ['ai-ready dam', 'content home'] },
            { page: 'https://getmasset.com/software/mcp', suggestedKeywords: ['mcp server', 'ai-ready dam'] },
         ],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'https://www.GetMasset.com/path' } }), res);

      expect(res.statusCode).toBe(201);
      const payload = res.payload;
      // Domain normalized to a bare host before creation.
      expect(payload.domain).toBe('getmasset.com');
      expect(mockDomain.create).toHaveBeenCalledTimes(1);

      // Keywords are globally deduped: the second "ai-ready dam" is dropped.
      expect(payload.discoveredKeywords).toEqual(['ai-ready dam', 'content home', 'mcp server']);
      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      expect(created.map((k) => k.keyword)).toEqual(['ai-ready dam', 'content home', 'mcp server']);
      // Each keyword carries its page's pathname as target_page.
      expect(created.find((k) => k.keyword === 'mcp server').target_page).toBe('/software/mcp');
      expect(created.find((k) => k.keyword === 'ai-ready dam').target_page).toBe('/');

      // Background SERP refresh is kicked off (not awaited) and rankings are pending.
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(payload.rankingsPending).toBe(true);

      // The beacon site id IS the domain; nothing is provisioned or stamped.
      expect(payload.siteId).toBe('getmasset.com');
      expect(payload.analyticsReady).toBe(true);
      expect(payload).not.toHaveProperty('umamiWebsiteId');

      // Install snippet + guides come back, embedding the domain as the site id.
      expect(payload.installSnippet).toContain('data-domain="getmasset.com"');
      expect(payload.installGuides.platforms.length).toBeGreaterThan(0);
      expect(payload.note).toBeNull();
   });

   it('reuses an already-owned domain row instead of creating a duplicate', async () => {
      const row = domainRow({ ID: 11, domain: 'example.com' });
      mockDomain.findOne.mockResolvedValue(row);
      mockDiscover.mockResolvedValue({ domain: 'example.com', candidates: [] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'example.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(mockDomain.create).not.toHaveBeenCalled();
      // The beacon site id is the domain, whether the row is new or reused.
      expect(res.payload.siteId).toBe('example.com');
      expect(res.payload).not.toHaveProperty('umamiWebsiteId');
   });

   it('caps the number of added keywords at the onboard max (50)', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 12, domain: 'big.com' }));
      // One page with 70 unique candidate keywords; the onboard cap (50) must clamp it.
      const many = Array.from({ length: 70 }, (_v, i) => `keyword phrase ${i}`);
      mockDiscover.mockResolvedValue({
         domain: 'big.com',
         candidates: [{ page: 'https://big.com/', suggestedKeywords: many }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'big.com' } }), res);

      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      expect(created.length).toBe(50);
      expect(res.payload.discoveredKeywords.length).toBe(50);
   });
});

describe('POST /api/onboard canonicalization + already-registered guard', () => {
   // The domain is canonicalized once up front and used for find + create, so a "www."/uppercase/
   // trailing-dot variant resolves and stores the ONE canonical form. Before creating, a canonical
   // name already registered is rejected, so a canonical-colliding sibling can never become a
   // duplicate row.
   it('rejects a domain whose canonical form is already registered without creating', async () => {
      asCaller(ADMIN);
      // First findOne is the access lookup (not found here) -> null.
      // Second findOne is the canonical existence check -> an already-registered row.
      mockDomain.findOne
         .mockResolvedValueOnce(null)
         .mockResolvedValueOnce(domainRow({ ID: 99, domain: 'getmasset.com', owner_id: null }));

      const res = makeRes();
      // A trailing-dot variant of an already-registered canonical domain.
      await onboardHandler(makeReq({ body: { domain: 'getmasset.com.' } }), res);

      expect(res.statusCode).toBe(400);
      expect((res.payload as { error?: string }).error).toMatch(/already registered/i);
      expect(mockDomain.create).not.toHaveBeenCalled();
   });

   it('canonicalizes the create + find: a raw variant stores the bare canonical domain', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 40, domain: 'getmasset.com' }));
      mockDiscover.mockResolvedValue({ domain: 'getmasset.com', candidates: [] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'WWW.GetMasset.com.' } }), res);

      expect(res.statusCode).toBe(201);
      // The find AND the create both use the canonical bare host.
      expect(mockDomain.findOne.mock.calls[0][0].where.domain).toBe('getmasset.com');
      expect(mockDomain.create.mock.calls[0][0].domain).toBe('getmasset.com');
      expect((res.payload as { domain?: string }).domain).toBe('getmasset.com');
   });
});

describe('POST /api/onboard graceful degradation', () => {
   it('always returns the beacon snippet (site id = domain), since there is nothing to provision', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 30, domain: 'noanalytics.com' }));
      mockDiscover.mockResolvedValue({
         domain: 'noanalytics.com',
         candidates: [{ page: 'https://noanalytics.com/', suggestedKeywords: ['a keyword'] }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'noanalytics.com' } }), res);

      expect(res.statusCode).toBe(201);
      // The domain, keywords, and rankings come back.
      expect(res.payload.domain).toBe('noanalytics.com');
      expect(res.payload.rankingsPending).toBe(true);
      // The beacon always attributes, so analytics is ready and a snippet is always handed out.
      expect(res.payload.siteId).toBe('noanalytics.com');
      expect(res.payload.analyticsReady).toBe(true);
      expect(res.payload).not.toHaveProperty('umamiWebsiteId');
      expect(res.payload.installSnippet).toContain('data-domain="noanalytics.com"');
      expect(res.payload.installGuides.platforms.length).toBeGreaterThan(0);
   });

   it('surfaces a discovery error as the note when no keyword candidates are found', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 31, domain: 'unreachable.example' }));
      mockDiscover.mockResolvedValue({ domain: 'unreachable.example', candidates: [], error: 'Could not reach this site.' });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'unreachable.example' } }), res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.discoveredKeywords).toEqual([]);
      expect(res.payload.rankingsPending).toBe(false);
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
      expect(res.payload.note).toMatch(/could not reach/i);
   });
});

describe('POST /api/onboard note + timing behavior', () => {
   it('surfaces the empty-keywords warning when discovery finds nothing', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 60, domain: 'twoissues.com' }));
      // Crawl succeeds but finds no keywords -> empty-keywords note. There is no analytics-provision
      // note anymore (the beacon always attributes), so only the auto-detect-failed note fires.
      mockDiscover.mockResolvedValue({ domain: 'twoissues.com', candidates: [] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'twoissues.com' } }), res);

      expect(res.statusCode).toBe(201);
      const note = (res.payload as { note?: string }).note || '';
      expect(note).toMatch(/could not auto-detect/i);
   });

   it('sets the scraper-missing note and rankingsPending false when no SERP source is configured', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 61, domain: 'noscraper.com' }));
      mockDiscover.mockResolvedValue({
         domain: 'noscraper.com',
         candidates: [{ page: 'https://noscraper.com/', suggestedKeywords: ['a keyword'] }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));
      mockSettings.mockResolvedValue({ scraper_type: 'none', scaping_api: '' });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'noscraper.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.rankingsPending).toBe(false);
      expect(res.payload.timingNote).toBeNull();
      expect((res.payload as { note?: string }).note).toMatch(/rank tracking is not configured/i);
      // Keywords were still added even with no scraper.
      expect(mockKeyword.bulkCreate).toHaveBeenCalledTimes(1);
   });

   it('returns a timing note and rankingsPending true when keywords are added with a SERP source', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 62, domain: 'timed.com' }));
      mockDiscover.mockResolvedValue({
         domain: 'timed.com',
         candidates: [{ page: 'https://timed.com/', suggestedKeywords: ['a keyword'] }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'timed.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.rankingsPending).toBe(true);
      expect(res.payload.timingNote).toMatch(/first google rank check/i);
   });
});

describe('POST /api/onboard guards', () => {
   it('rejects an unauthorized caller with 401', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'nope' });
      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'x.com' } }), res);
      expect(res.statusCode).toBe(401);
   });

   it('rejects a non-POST method with 405', async () => {
      const res = makeRes();
      await onboardHandler(makeReq({ method: 'GET', body: {} }), res);
      expect(res.statusCode).toBe(405);
   });

   it('rejects a missing domain with 400', async () => {
      const res = makeRes();
      await onboardHandler(makeReq({ body: {} }), res);
      expect(res.statusCode).toBe(400);
   });
});

describe('POST /api/onboard Firecrawl recommendation', () => {
   beforeEach(() => {
      mockFirecrawlConfigured.mockReturnValue(true);
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 30, domain: 'firecrawl.com' }));
   });
   // Restore the file-wide defaults so the configured-mock cannot bleed into other suites.
   afterEach(() => {
      mockFirecrawlConfigured.mockReturnValue(false);
      mockExtract.mockResolvedValue({ businessName: '', keywords: [], error: 'Firecrawl is not configured.' });
   });

   it('adds the Firecrawl-recommended keywords (not the heuristic) and surfaces the business name', async () => {
      mockExtract.mockResolvedValue({
         businessName: 'Firecrawl Co',
         keywords: [
            { keyword: 'ai content management software', targetPage: '/software' },
            { keyword: 'dam for marketing teams', targetPage: '/dam' },
         ],
      });
      // The heuristic would return something different; assert it is NOT used.
      mockDiscover.mockResolvedValue({ domain: 'firecrawl.com', candidates: [{ page: 'https://firecrawl.com/x', suggestedKeywords: ['heuristic only'] }] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'firecrawl.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(mockDiscover).not.toHaveBeenCalled();
      expect(res.payload.businessName).toBe('Firecrawl Co');
      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      expect(created.map((k) => k.keyword)).toEqual(['ai content management software', 'dam for marketing teams']);
      // target pages from Firecrawl are carried through to the scoreboard join
      expect(created.find((k) => k.keyword === 'ai content management software').target_page).toBe('/software');
      expect(res.payload.discoveredKeywords).toEqual(['ai content management software', 'dam for marketing teams']);
   });

   it('GRADES Firecrawl candidates against the scraped pages and adds only the quality ones (junk dropped)', async () => {
      // Firecrawl returns a mix of real terms + nav/doc-chrome junk, plus the scraped pages (crawl).
      // The deterministic grader (run for real, not mocked) must keep the relevant commercial terms and
      // drop the junk before anything is tracked.
      mockExtract.mockResolvedValue({
         businessName: 'Acme',
         keywords: [
            { keyword: 'agents', targetPage: '/' },
            { keyword: 'all guides', targetPage: '/' },
            { keyword: 'about us', targetPage: '/' },
            { keyword: 'infrastructure for ai', targetPage: '/' },
            { keyword: 'fluid compute', targetPage: '/' },
         ],
         pages: [
            { url: 'https://acme.com/', title: 'Acme: Infrastructure for AI', text: 'Acme is the infrastructure for ai. Fluid compute scales your workloads. Trusted by 40% of teams.' },
            { url: 'https://acme.com/pricing', title: 'Pricing', text: 'Pricing for infrastructure for ai and fluid compute. Plans for teams. 99% uptime.' },
            { url: 'https://acme.com/product', title: 'Product', text: 'Infrastructure for ai and fluid compute, built in. Over 100000 developers.' },
         ],
      });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'firecrawl.com' } }), res);

      expect(res.statusCode).toBe(201);
      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      const addedKw = created.map((k) => k.keyword);
      expect(addedKw).toContain('infrastructure for ai');
      expect(addedKw).toContain('fluid compute');
      // The nav/doc-chrome junk was graded out, never tracked.
      expect(addedKw).not.toContain('agents');
      expect(addedKw).not.toContain('all guides');
      expect(addedKw).not.toContain('about us');
   });

   it('falls back to the heuristic crawler when Firecrawl returns no keywords', async () => {
      mockExtract.mockResolvedValue({ businessName: '', keywords: [], error: 'Firecrawl extract timed out.' });
      mockDiscover.mockResolvedValue({ domain: 'firecrawl.com', candidates: [{ page: 'https://firecrawl.com/', suggestedKeywords: ['fallback keyword'] }] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'firecrawl.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(mockExtract).toHaveBeenCalled();
      expect(mockDiscover).toHaveBeenCalled(); // fell back
      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      expect(created.map((k) => k.keyword)).toEqual(['fallback keyword']);
   });

});
