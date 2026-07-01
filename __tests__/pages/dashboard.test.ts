/**
 * dashboard route: the default "show me an overview" experience.
 *
 * Covers:
 *   - compose: every section populated from sample pillar data.
 *   - empty domain: coherent, honest output (notes, not crashes) with the starter questions.
 *   - contextual question selection: starter set when empty, focus/AEO/conversion questions when
 *     the matching signal is present.
 *   - rendered: a non-empty monospace string.
 *   - tenancy/HTTP: 403 not-owned, 400 missing domain, 405 non-GET, 401 unauthorized.
 *
 * The analytics provider is mocked at utils/analytics so no real Umami/Lodd call happens. The DB
 * models and authorize are mocked per the repo route-test convention.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({
   __esModule: true,
   Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') },
}));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/analytics', () => ({
   __esModule: true,
   getAnalyticsProvider: jest.fn(),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/dashboard';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockGoal = GoalModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockProvider = getAnalyticsProvider as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const pv = (session: string, page: string, source: string, is_bot: boolean, created: string) =>
   row({ session, page, source, is_bot, created, type: 'pageview', device: 'desktop', country: 'US' });
// A keyword row with the JSON columns parseKeywords expects, so the test stays single-line per row.
const kw = (keyword: string, position: number, url: string, target_page: string, history: string) =>
   row({ keyword, position, url, target_page, history, tags: '[]', lastResult: '[]', lastUpdateError: 'false' });

const makeReq = (query: Record<string, string>, method = 'GET'): NextApiRequest => ({
   method, query, body: {}, headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

// A provider stub: returns whatever the test sets; defaults to empty-but-valid results.
const providerStub = (over: Partial<Record<string, unknown>> = {}) => ({
   getPageTraffic: jest.fn(async () => over.traffic || { pages: [], error: null }),
   getReferralSources: jest.fn(async () => over.referrals || { sources: [], error: null }),
   getSummary: jest.fn(async () => over.summary || ({
      pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null,
   })),
});

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockKeyword.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
   mockGoal.findAll.mockResolvedValue([]);
   mockProvider.mockReturnValue(providerStub());
});

describe('GET /api/dashboard', () => {
   it('composes every section from sample pillar data', async () => {
      // SEO: one page-one keyword, one striking-distance keyword, one unranked, with rank history.
      mockKeyword.findAll.mockResolvedValue([
         kw('masset', 1, '["https://getmasset.com/"]', '/', JSON.stringify({ '2026-05-01': 8, '2026-06-01': 1 })),
         kw('dam mcp', 14, '["https://getmasset.com/mcp"]', '/mcp', JSON.stringify({ '2026-05-01': 20, '2026-06-01': 14 })),
         kw('unranked term', 0, '[]', '/x', '{}'),
      ]);
      // Sessions: 2 human (one direct, one from ChatGPT), 1 bot. webvital query returns separately.
      mockEvent.findAll
         .mockResolvedValueOnce([
            pv('A', '/', 'direct', false, '2026-06-10T10:00:00.000Z'),
            pv('A', '/pricing', 'direct', false, '2026-06-10T10:01:00.000Z'),
            pv('B', '/', 'ai', false, '2026-06-10T11:00:00.000Z'),
            pv('C', '/', 'direct', true, '2026-06-10T12:00:00.000Z'),
         ])
         // web-vital rows (second findAll call).
         .mockResolvedValueOnce([
            { page: '/', label: 'LCP', metric_value: 2100 },
            { page: '/', label: 'LCP', metric_value: 2300 },
            { page: '/pricing', label: 'CLS', metric_value: 0.05 },
         ]);
      mockGoal.findAll.mockResolvedValue([
         row({ ID: 7, name: 'Demo Booked', kind: 'page_reached', match_value: '/pricing', match_page: null, match_mode: 'prefix', value: 500 }),
      ]);
      mockProvider.mockReturnValue(providerStub({
         traffic: { pages: [
            { url: 'https://getmasset.com/', pathClean: '/', page_views: 120 },
            { url: 'https://getmasset.com/pricing', pathClean: '/pricing', page_views: 40 },
         ],
         error: null },
         referrals: { sources: [
            { name: 'chatgpt.com', type: 'ai', engine: 'ChatGPT', isAI: true, unique_visitors: 9 },
            { name: 'google.com', type: 'search', engine: null, isAI: false, unique_visitors: 30 },
         ],
         error: null },
         summary: { pageviews: 160, visitors: 50, bounceRate: 40, avgDuration: 30, pagesPerVisit: 1.6, error: null },
      }));

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);

      expect(res.statusCode).toBe(200);
      const d = res.payload.dashboard;
      // headline
      expect(d.headline.aiReferredVisitors).toBe(9);
      expect(d.headline.topAction).toBeTruthy();
      // topPages: '/' should lead by pageviews and carry entries from sessions (A + B landed on '/').
      expect(d.topPages.data[0].path).toBe('/');
      expect(d.topPages.data[0].pageviews).toBe(120);
      expect(d.topPages.data.find((p: any) => p.path === '/').entries).toBe(2);
      // topSources: channels present (direct + ai), referrers include the AI-tagged ChatGPT.
      expect(d.topSources.data.byChannel.length).toBeGreaterThan(0);
      expect(d.topSources.data.topReferrers.some((r: any) => r.isAI)).toBe(true);
      // topKeywords: best first (#1 masset).
      expect(d.topKeywords.data[0].keyword).toBe('masset');
      // rankDistribution: 3 total, 1 in top 3/10/page1, 1 not in top 100.
      expect(d.rankDistribution.data.totalKeywords).toBe(3);
      expect(d.rankDistribution.data.onPageOne).toBe(1);
      expect(d.rankDistribution.data.notInTop100).toBe(1);
      // aiReferrals: 9 visitors from ChatGPT.
      expect(d.aiReferrals.data.totalAiVisitors).toBe(9);
      expect(d.aiReferrals.data.byEngine[0].engine).toBe('ChatGPT');
      // webVitals: LCP has samples.
      expect(d.webVitals.data.totalSamples).toBe(3);
      expect(d.webVitals.data.metrics.find((m: any) => m.metric === 'LCP').sampleCount).toBe(2);
      // conversions: goal present (Demo Booked), section not null.
      expect(d.conversions).not.toBeNull();
      expect(d.conversions.data[0].goal).toBe('Demo Booked');
      // whatChanged: masset climbed 8 -> 1 (improved).
      expect(d.whatChanged.data.some((c: any) => c.keyword === 'masset' && c.kind === 'rank-improved')).toBe(true);
      // rendered is a non-empty string.
      expect(typeof res.payload.rendered).toBe('string');
      expect(res.payload.rendered.length).toBeGreaterThan(100);
      expect(res.payload.rendered).toContain('s33k OVERVIEW');
      expect(res.payload.rendered).toContain('TRY ASKING');
      // contextual questions present.
      expect(Array.isArray(res.payload.suggestedQuestions)).toBe(true);
      expect(res.payload.suggestedQuestions.length).toBeGreaterThan(0);
   });

   it('returns coherent, honest output and the starter questions for an empty domain', async () => {
      // All defaults: no keywords, no events, no goals, empty provider results.
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      const d = res.payload.dashboard;
      // Each section is empty-safe with a note instead of a crash.
      expect(d.topPages.note).toBeTruthy();
      expect(d.rankDistribution.data.totalKeywords).toBe(0);
      expect(d.topKeywords.note).toBeTruthy();
      expect(d.aiReferrals.data.note).toBeTruthy();
      expect(d.webVitals.data.note).toBeTruthy();
      // No goals -> conversions pillar omitted entirely.
      expect(d.conversions).toBeNull();
      // Empty domain -> starter questions (includes the install/discover onboarding prompts).
      const qs = res.payload.suggestedQuestions.map((q: any) => q.tool);
      expect(qs).toContain('discover_pages');
      expect(qs).toContain('install_instructions');
      // rendered still produced.
      expect(res.payload.rendered).toContain('s33k OVERVIEW');
   });

   it('selects AEO and conversion questions when those signals are present', async () => {
      mockKeyword.findAll.mockResolvedValue([
         kw('masset', 14, '["https://getmasset.com/mcp"]', '/mcp', '{}'),
      ]);
      mockEvent.findAll
         .mockResolvedValueOnce([pv('A', '/', 'ai', false, '2026-06-10T10:00:00.000Z')])
         .mockResolvedValueOnce([]);
      mockGoal.findAll.mockResolvedValue([
         row({ ID: 1, name: 'Signup', kind: 'event', match_value: 'form_submit', match_page: null, match_mode: 'prefix', value: null }),
      ]);
      mockProvider.mockReturnValue(providerStub({
         referrals: { sources: [{ name: 'perplexity.ai', type: 'ai', engine: 'Perplexity', isAI: true, unique_visitors: 4 }], error: null },
         summary: { pageviews: 5, visitors: 3, bounceRate: 50, avgDuration: 10, pagesPerVisit: 1.2, error: null },
      }));

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const tools = res.payload.suggestedQuestions.map((q: any) => q.tool);
      // AI referrals exist -> AEO question surfaces.
      expect(tools).toContain('ai_referrals');
      // Goals defined -> a conversion question surfaces.
      expect(tools).toContain('conversion_attribution');
      // Striking-distance keyword present -> the quick-win question surfaces.
      expect(tools).toContain('striking_distance');
   });

   it('403s when the domain is not owned', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s when the domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }, 'POST'), res);
      expect(res.statusCode).toBe(405);
   });

   it('401s when not authorized', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Not authorized' });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(401);
   });
});
