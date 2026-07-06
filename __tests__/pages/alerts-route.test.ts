/**
 * Tests for the proactive-analyst endpoint (pages/api/alerts.ts).
 *
 * The route is the tenant-scoped read layer in front of the pure engine
 * (utils/analyst.ts). It pulls the current and immediately-prior period across
 * every pillar (rank from Keyword history, traffic + AI referrals from the
 * analytics provider, conversions from s33k_event), shapes them, and runs
 * detectChanges. Its hard contracts:
 *
 *   1. OWNERSHIP: a domain the caller does not own returns 403 and NO pillar read
 *      runs (Keyword/S33kEvent.findAll are never called).
 *   2. AUTH / METHOD / INPUT: 401 unauthorized, 405 non-GET, 400 missing domain.
 *   3. HAPPY PATH: an owned domain with real deltas returns 200, alerts, a
 *      topPriority, the period/comparedTo, and per-pillar dataAvailability notes.
 *   4. GRACEFUL DEGRADATION: any single pillar read REJECTING must not 500; the
 *      route degrades that pillar and still returns a usable 200 with the other
 *      pillars intact. Many failing at once still yields a 200.
 *   5. PRIOR-WINDOW DERIVATION: additive provider totals use prior = doubled
 *      minus current; the DB pillars use explicit windows. The route still
 *      produces the expected alerts from those derived priors.
 *
 * All heavy deps (db, Domain, Keyword, S33kEvent, authorize, the analytics
 * provider) are mocked; scopeWhere runs for real. No DB, no network, no LLM.
 */

jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

// eslint-disable-next-line import/first
import handler from '../../pages/api/alerts';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import Domain from '../../database/models/domain';
// eslint-disable-next-line import/first
import Keyword from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEvent from '../../database/models/s33kEvent';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedKeywordFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedEventFindAll = (S33kEvent as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

/** Milliseconds ago, as the ISO string the route stores in `history` date keys. */
const daysAgoKey = (days: number): string => {
   const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
   return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * A DB-row stand-in for parseKeywords: the route calls .get({ plain: true }) and
 * parseKeywords JSON.parses history/tags/lastResult, so those must be strings.
 * `history` maps a recent date (in the current window) and an older date (in the
 * prior window) to positions, so positionInWindow resolves a current vs prior rank.
 * `rawHistory`, when supplied, replaces the curPos/priorPos-derived map entirely,
 * for tests that need history entries outside the standard day-1/day-10 spots
 * (e.g. sparse, weekly-cadence scrape gaps).
 */
const keywordRow = (overrides: {
   keyword: string,
   target_page?: string,
   curPos?: number,
   priorPos?: number,
   lastResult?: { position: number, url: string, title?: string }[],
   rawHistory?: Record<string, number>,
}) => {
   let history: Record<string, number> = {};
   if (overrides.rawHistory) {
      history = overrides.rawHistory;
   } else {
      // 7d default period: current window is the last 7 days, prior is days 7-14.
      if (overrides.curPos !== undefined) { history[daysAgoKey(1)] = overrides.curPos; }
      if (overrides.priorPos !== undefined) { history[daysAgoKey(10)] = overrides.priorPos; }
   }
   const plain = {
      ID: 1,
      keyword: overrides.keyword,
      domain: 'getmasset.com',
      device: 'desktop',
      country: 'US',
      position: overrides.curPos ?? 0,
      url: 'https://getmasset.com/',
      target_page: overrides.target_page ?? '/',
      history: JSON.stringify(history),
      tags: '[]',
      lastResult: JSON.stringify(overrides.lastResult ?? []),
      lastUpdateError: 'false',
      sticky: false,
   };
   return { get: () => plain };
};

/** A minimal Next-style GET req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query, headers: {}, url: '/api/alerts' } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/**
 * A provider stub. getSummary and getReferralSources are each called twice (current
 * window and doubled window); the stub returns the requested period's value from a
 * lookup so the route's prior = doubled - current derivation can be exercised.
 * Any method named in `throwOn` rejects, to test per-pillar degradation.
 */
const providerStub = (opts: {
   summaryByPeriod?: Record<string, any>,
   referralByPeriod?: Record<string, { sources: any[], error: string | null }>,
   pagesByPeriod?: Record<string, { pages: any[], error: string | null }>,
   throwOn?: Set<string>,
} = {}) => {
   const throwOn = opts.throwOn ?? new Set<string>();
   const emptySummary = { pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null };
   return {
      getSummary: jest.fn(async (_d: string, period: string) => {
         if (throwOn.has('getSummary')) { throw new Error('summary backend exploded'); }
         return (opts.summaryByPeriod && opts.summaryByPeriod[period]) || emptySummary;
      }),
      getReferralSources: jest.fn(async (_d: string, period: string) => {
         if (throwOn.has('getReferralSources')) { throw new Error('referral backend exploded'); }
         return (opts.referralByPeriod && opts.referralByPeriod[period]) || { sources: [], error: null };
      }),
      getPageTraffic: jest.fn(async (_d: string, period: string) => {
         if (throwOn.has('getPageTraffic')) { throw new Error('page traffic backend exploded'); }
         return (opts.pagesByPeriod && opts.pagesByPeriod[period]) || { pages: [], error: null };
      }),
   };
};

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller and an owned domain by default; individual tests override.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedKeywordFindAll.mockResolvedValue([]);
   mockedEventFindAll.mockResolvedValue([]);
   mockedGetProvider.mockReturnValue(providerStub());
});

describe('alerts route: auth, method, and input gates', () => {
   it('returns 401 when the request is not authorized', async () => {
      mockedAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'No token' });
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(401);
   });

   it('returns 405 for a non-GET method', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      req.method = 'POST';
      await handler(req, res);
      expect(captured.status).toBe(405);
   });

   it('returns 400 when the domain is missing', async () => {
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);
      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/domain/i);
   });
});

describe('alerts route: ownership gate', () => {
   it('returns 403 and reads NO pillar data for a domain the caller does not own', async () => {
      mockedDomainFindOne.mockResolvedValue(null); // not owned
      const { req, res, captured } = makeReqRes({ domain: 'someone-elses.com' });
      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(captured.body.error).toMatch(/not found/i);
      // The ownership gate short-circuits before any pillar read.
      expect(mockedKeywordFindAll).not.toHaveBeenCalled();
      expect(mockedEventFindAll).not.toHaveBeenCalled();
   });
});

describe('alerts route: happy path', () => {
   it('returns 200 with alerts, a topPriority, the period/comparedTo, and dataAvailability notes', async () => {
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({ keyword: 'DAM MCP server', target_page: '/software/mcp', curPos: 11, priorPos: 4 }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         summaryByPeriod: {
            '7d': { pageviews: 60, visitors: 50, error: null },
            '14d': { pageviews: 160, visitors: 130, error: null }, // prior = 100/80
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      expect(Array.isArray(captured.body.alerts)).toBe(true);
      expect(captured.body.alerts.length).toBeGreaterThan(0);
      expect(captured.body.topPriority).not.toBeNull();
      expect(captured.body.period).toBe('7d');
      expect(captured.body.comparedTo).toBe('the prior 7d window');
      expect(captured.body.generatedFor).toEqual({ domain: 'getmasset.com', period: '7d' });
      // Per-pillar availability notes are always present.
      expect(captured.body.dataAvailability).toEqual(expect.objectContaining({
         rank: expect.any(String), traffic: expect.any(String), ai: expect.any(String), conversions: expect.any(String),
      }));
      // The rank page-one drop surfaced as a high-severity alert.
      const rank = captured.body.alerts.find((a: any) => a.pillar === 'rank');
      expect(rank).toBeDefined();
      expect(rank.severity).toBe('high');
   });

   it('defaults to a 7d period when none is supplied', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.period).toBe('7d');
   });

   it('derives prior AI referrals as doubled minus current and grows an existing engine', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         referralByPeriod: {
            // Current window: 30 ChatGPT visitors. Doubled window: 40 total, so the
            // route derives prior = 40 - 30 = 10. Current (30) vs prior (10) is +200%,
            // well over the 30% AI threshold -> a medium "referrals grew" alert.
            '7d': { sources: [{ name: 'chatgpt.com', engine: 'ChatGPT', isAI: true, unique_visitors: 30 }], error: null },
            '14d': { sources: [{ name: 'chatgpt.com', engine: 'ChatGPT', isAI: true, unique_visitors: 40 }], error: null },
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const aiAlert = captured.body.alerts.find((a: any) => a.pillar === 'ai');
      expect(aiAlert).toBeDefined();
      expect(aiAlert.severity).toBe('medium');
      expect(aiAlert.headline).toMatch(/ChatGPT referrals grew/);
   });

   it('flags a brand-new AI engine HIGH when it is absent from the doubled window entirely', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         referralByPeriod: {
            // Perplexity appears only in the current window. The doubled window does not
            // list it at all, so the derived prior set has no Perplexity entry -> the
            // engine is genuinely brand-new and surfaces as a high-severity AEO signal.
            '7d': { sources: [{ name: 'perplexity.ai', engine: 'Perplexity', isAI: true, unique_visitors: 6 }], error: null },
            '14d': { sources: [], error: null },
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const aiAlert = captured.body.alerts.find((a: any) => a.pillar === 'ai');
      expect(aiAlert).toBeDefined();
      expect(aiAlert.severity).toBe('high');
      expect(aiAlert.headline).toMatch(/Perplexity started referring/);
   });

   it('flags a conversion drop from the s33k_event windows', async () => {
      // First event findAll is the current window, second is the prior window.
      const formRow = () => ({
         type: 'form_submit', page: '/', label: 'demo', selector: null, value: null, session: 's', created: new Date().toJSON(),
      });
      mockedEventFindAll
         .mockResolvedValueOnce([formRow(), formRow()]) // current: 2
         .mockResolvedValueOnce([formRow(), formRow(), formRow(), formRow(), formRow()]); // prior: 5 -> -60%

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const conv = captured.body.alerts.find((a: any) => a.pillar === 'conversions');
      expect(conv).toBeDefined();
      expect(conv.severity).toBe('high');
      expect(conv.headline).toMatch(/Form submissions fell/);
   });

   it('returns a quiet 200 (no alerts, null topPriority) when nothing changed', async () => {
      // All pillars empty/identical: no deltas to report.
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.alerts).toEqual([]);
      expect(captured.body.topPriority).toBeNull();
      expect(captured.body.error).toBeNull();
   });
});

describe('alerts route: graceful degradation (never 500)', () => {
   it('degrades only the traffic pillar (still 200) when getSummary rejects', async () => {
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({ keyword: 'masset', target_page: '/', curPos: 12, priorPos: 4 }), // high rank drop
      ]);
      mockedGetProvider.mockReturnValue(providerStub({ throwOn: new Set(['getSummary']) }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      // Traffic could not be measured (zeroed), so no traffic alert and the rank alert still fired.
      expect(captured.body.alerts.find((a: any) => a.pillar === 'traffic')).toBeUndefined();
      expect(captured.body.alerts.find((a: any) => a.pillar === 'rank')).toBeDefined();
   });

   it('degrades the AI referral pillar (still 200) when getReferralSources rejects', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ throwOn: new Set(['getReferralSources']) }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      // The AI availability note explains the referral data was unavailable.
      expect(captured.body.dataAvailability.ai).toMatch(/unavailable/i);
      // No AI alert is produced when the referral read fails.
      expect(captured.body.alerts.find((a: any) => a.pillar === 'ai')).toBeUndefined();
   });

   it('degrades the rank pillar (still 200) when the Keyword query rejects', async () => {
      mockedKeywordFindAll.mockRejectedValue(new Error('keyword table missing'));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.alerts.find((a: any) => a.pillar === 'rank')).toBeUndefined();
      expect(captured.body.dataAvailability.rank).toMatch(/no keywords/i);
   });

   it('degrades the conversion pillar (still 200) when the S33kEvent query rejects', async () => {
      mockedEventFindAll.mockRejectedValue(new Error('event table missing'));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.alerts.find((a: any) => a.pillar === 'conversions')).toBeUndefined();
   });

   it('still returns a usable 200 when MANY sub-signals fail at once', async () => {
      mockedKeywordFindAll.mockRejectedValue(new Error('kw down'));
      mockedEventFindAll.mockRejectedValue(new Error('event down'));
      mockedGetProvider.mockReturnValue(providerStub({ throwOn: new Set(['getSummary', 'getReferralSources']) }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(Array.isArray(captured.body.alerts)).toBe(true);
      expect(captured.body.alerts).toEqual([]); // nothing measurable -> no fabricated alerts
      expect(captured.body.topPriority).toBeNull();
      expect(captured.body.dataAvailability).toBeDefined();
   });
});

describe('alerts route: the since parameter (poll "what changed since ...")', () => {
   it('returns a clear 400 for an unparseable since value', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', since: 'yesterday-ish' });
      await handler(req, res);
      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/since/i);
      expect(captured.body.error).toMatch(/ISO 8601/);
   });

   it('returns a clear 400 for a since value in the future', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toJSON();
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', since: future });
      await handler(req, res);
      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/past/i);
   });

   it('returns a clear 400 for a since value past the 365-day lookback cap', async () => {
      const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toJSON();
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', since: ancient });
      await handler(req, res);
      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/365/);
   });

   it('scopes the current window to [since, now), echoes since back, and derives the provider period in hours', async () => {
      // 23.5 hours ago rounds UP to a 24h provider window (ceil always COVERS the window).
      const since = new Date(Date.now() - 23.5 * 60 * 60 * 1000).toJSON();
      const provider = providerStub();
      mockedGetProvider.mockReturnValue(provider);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', since });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.since).toBe(since);
      expect(captured.body.period).toBe('24h');
      expect(captured.body.comparedTo).toBe('the prior 24h window');
      // The provider reads used the derived window and its doubled companion.
      expect(provider.getSummary).toHaveBeenCalledWith('getmasset.com', '24h');
      expect(provider.getSummary).toHaveBeenCalledWith('getmasset.com', '48h');
   });

   it('floors a short since window at 24h so provider reads compare equal windows', async () => {
      // The provider's period grammar floors any window at 1 day (eventPeriodCutoff's
      // Math.max(1, days)). Without the 24h floor here, since=6h would read a 24h current
      // window against a differently-sized doubled window and fabricate swings from the
      // unequal-window subtraction. The floor keeps doubled at exactly 2x and the echoed
      // period honest about what the provider actually read.
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toJSON();
      const provider = providerStub();
      mockedGetProvider.mockReturnValue(provider);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', since });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.period).toBe('24h');
      expect(captured.body.comparedTo).toBe('the prior 24h window');
      expect(provider.getSummary).toHaveBeenCalledWith('getmasset.com', '24h');
      expect(provider.getSummary).toHaveBeenCalledWith('getmasset.com', '48h');
   });

   it('takes precedence over period when both are supplied', async () => {
      const since = new Date(Date.now() - 23.5 * 60 * 60 * 1000).toJSON();
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', since, period: '30d' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.period).toBe('24h');
   });

   it('does not include since in the response when it was not supplied', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.since).toBeUndefined();
   });
});

describe('alerts route: content decay', () => {
   it('flags a decaying page from per-page traffic (prior derived as doubled minus current)', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         pagesByPeriod: {
            // Current window: 10 views. Doubled window: 60, so prior = 50: an 80% decline
            // off a >= 20-view baseline -> a high-severity content_decay alert.
            '7d': { pages: [{ url: '/blog/x', pathClean: '/blog/x', page_views: 10 }], error: null },
            '14d': { pages: [{ url: '/blog/x', pathClean: '/blog/x', page_views: 60 }], error: null },
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const decay = captured.body.alerts.find((a: any) => a.pillar === 'content_decay');
      expect(decay).toBeDefined();
      expect(decay.severity).toBe('high');
      expect(decay.headline).toMatch(/\/blog\/x/);
      expect(decay.recommendation).toMatch(/refresh this content/i);
      expect(captured.body.dataAvailability.content).toMatch(/content decay/i);
   });

   it('names the flat-rank stale-content variant when a tracked keyword held its rank', async () => {
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({ keyword: 'content dam', target_page: '/blog/x', curPos: 5, priorPos: 5 }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         pagesByPeriod: {
            '7d': { pages: [{ url: '/blog/x', pathClean: '/blog/x', page_views: 20 }], error: null },
            '14d': { pages: [{ url: '/blog/x', pathClean: '/blog/x', page_views: 70 }], error: null },
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const decay = captured.body.alerts.find((a: any) => a.pillar === 'content_decay');
      expect(decay).toBeDefined();
      expect(decay.headline).toMatch(/rank held/i);
      expect(decay.detail).toMatch(/"content dam" still ranks #5/);
   });

   it('degrades only the content pillar (still 200) when getPageTraffic rejects', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ throwOn: new Set(['getPageTraffic']) }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      expect(captured.body.alerts.find((a: any) => a.pillar === 'content_decay')).toBeUndefined();
      expect(captured.body.dataAvailability.content).toMatch(/unavailable/i);
   });
});

describe('alerts route: SERP context on rank alerts', () => {
   it('enriches a rank drop with the domains immediately above, from the stored SERP (no new scrape)', async () => {
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({
            keyword: 'DAM MCP server',
            target_page: '/software/mcp',
            curPos: 11,
            priorPos: 4,
            lastResult: [
               { position: 8, url: 'https://www.bynder.com/dam' },
               { position: 9, url: 'https://brandfolder.com/mcp' },
               { position: 10, url: 'https://seismic.com/dam-mcp' },
               { position: 11, url: 'https://getmasset.com/software/mcp' },
               { position: 12, url: 'https://paperflite.com/x' },
            ],
         }),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const rank = captured.body.alerts.find((a: any) => a.pillar === 'rank');
      expect(rank).toBeDefined();
      expect(rank.context).toBeDefined();
      expect(rank.context.priorPosition).toBe(4);
      expect(rank.context.currentPosition).toBe(11);
      // Nearest above first; the user's own domain and lower-ranked results are excluded.
      expect(rank.context.domainsAbove).toEqual(['seismic.com', 'brandfolder.com', 'bynder.com']);
   });

   it('still carries prior/current positions in context when the stored SERP is empty', async () => {
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({ keyword: 'masset', target_page: '/', curPos: 12, priorPos: 4 }),
      ]);
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const rank = captured.body.alerts.find((a: any) => a.pillar === 'rank');
      expect(rank.context).toEqual({ keyword: 'masset', priorPosition: 4, currentPosition: 12 });
   });
});

describe('alerts route: sparse (e.g. weekly) scrape history does not overstate novelty or miss drops', () => {
   it('does NOT report a long-held #1 keyword as newly ranking just because the 7d prior window has no scrape', async () => {
      // Only ONE scrape ever, 20 days ago (well outside the 7-14 day prior window a
      // fixed-width lookup would check), holding #1. A same-day-ish scrape landed
      // yesterday, still #1: nothing actually changed.
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({
            keyword: 'masset',
            target_page: '/',
            rawHistory: { [daysAgoKey(20)]: 1, [daysAgoKey(1)]: 1 },
         }),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.alerts.find((a: any) => a.pillar === 'rank')).toBeUndefined();
   });

   it('flags a HIGH drop-off for a ranked keyword that fell off the top 100, even with a sparse prior window', async () => {
      // Ranked #9 20 days ago (outside the 7-14 day prior window); a real scrape
      // yesterday confirms it is now unranked (position 0). The prior comparison
      // point must carry forward to the #9 scrape, not read as "no data".
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({
            keyword: 'senior-living',
            target_page: '/for/senior-living',
            rawHistory: { [daysAgoKey(20)]: 9, [daysAgoKey(1)]: 0 },
         }),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const rank = captured.body.alerts.find((a: any) => a.pillar === 'rank');
      expect(rank).toBeDefined();
      expect(rank.severity).toBe('high');
      expect(rank.headline).toMatch(/dropped off/i);
   });

   it('reports a genuinely brand-new keyword honestly as "first scrape data", not "started ranking"', async () => {
      // The ONLY scrape ever is inside the current window: no earlier scrape exists
      // at all, so this is a first data point, not a confirmed novel ranking.
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({
            keyword: 'brand new term',
            target_page: '/new',
            rawHistory: { [daysAgoKey(1)]: 7 },
         }),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const rank = captured.body.alerts.find((a: any) => a.pillar === 'rank');
      expect(rank).toBeDefined();
      expect(rank.severity).toBe('low');
      expect(rank.headline).toMatch(/first scrape data/i);
      expect(rank.headline).not.toMatch(/started ranking/i);
   });

   it('stays silent rather than inventing a drop when the CURRENT window has no scrape yet', async () => {
      // Ranked #6 20 days ago; NO scrape at all has landed in the current 7d window,
      // so we genuinely do not know the current status and must not fabricate a drop.
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({
            keyword: 'funeral-homes',
            target_page: '/for/funeral-homes',
            rawHistory: { [daysAgoKey(20)]: 6 },
         }),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.alerts.find((a: any) => a.pillar === 'rank')).toBeUndefined();
   });
});
