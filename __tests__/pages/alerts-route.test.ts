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
 */
const keywordRow = (overrides: {
   keyword: string,
   target_page?: string,
   curPos?: number,
   priorPos?: number,
}) => {
   const history: Record<string, number> = {};
   // 7d default period: current window is the last 7 days, prior is days 7-14.
   if (overrides.curPos !== undefined) { history[daysAgoKey(1)] = overrides.curPos; }
   if (overrides.priorPos !== undefined) { history[daysAgoKey(10)] = overrides.priorPos; }
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
      lastResult: '[]',
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
