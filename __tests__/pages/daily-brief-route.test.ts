/**
 * Tests for the on-demand daily-brief endpoint (pages/api/daily-brief.ts).
 *
 * The route is the tenant-scoped read layer in front of the pure composer
 * (utils/daily-brief.ts). It loads the analyst, dashboard, and AEO ROI signals for
 * an owned domain, composes one prioritized brief, and returns it plus a rendered
 * text block. Its hard contracts:
 *
 *   1. OWNERSHIP: a domain the caller does not own returns 403 and NO pillar read
 *      runs (Keyword/S33kEvent/Goal.findAll are never called).
 *   2. AUTH / METHOD / INPUT: 401 unauthorized, 405 non-GET, 400 missing domain.
 *   3. HAPPY PATH: an owned domain returns 200, a structured brief, and a non-empty
 *      rendered string; a real rank change surfaces in whatChanged.
 *   4. GRACEFUL DEGRADATION: any single read REJECTING must not 500; the route
 *      degrades and still returns a usable 200.
 *
 * All heavy deps are mocked; scopeWhere/parseKeywords/the pure composers run for
 * real. No DB, no network, no LLM.
 */

jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

// eslint-disable-next-line import/first
import handler from '../../pages/api/daily-brief';
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
// eslint-disable-next-line import/first
import Goal from '../../database/models/goal';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedKeywordFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedEventFindAll = (S33kEvent as unknown as { findAll: jest.Mock }).findAll;
const mockedGoalFindAll = (Goal as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

/** Milliseconds ago, as the ISO string the route stores in `history` date keys. */
const daysAgoKey = (days: number): string => {
   const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
   return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** A DB-row stand-in for parseKeywords with a current and prior in-window position. */
const keywordRow = (overrides: { keyword: string, target_page?: string, curPos?: number, priorPos?: number }) => {
   const history: Record<string, number> = {};
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
   const req = { method: 'GET', query, headers: {}, url: '/api/daily-brief' } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/** A provider stub returning the requested period's summary/referrals/traffic. */
const providerStub = (opts: {
   summaryByPeriod?: Record<string, any>,
   throwOn?: Set<string>,
} = {}) => {
   const throwOn = opts.throwOn ?? new Set<string>();
   const emptySummary = { pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null };
   return {
      getSummary: jest.fn(async (_d: string, period: string) => {
         if (throwOn.has('getSummary')) { throw new Error('summary backend exploded'); }
         return (opts.summaryByPeriod && opts.summaryByPeriod[period]) || emptySummary;
      }),
      getReferralSources: jest.fn(async () => {
         if (throwOn.has('getReferralSources')) { throw new Error('referral backend exploded'); }
         return { sources: [], error: null };
      }),
      getPageTraffic: jest.fn(async () => {
         if (throwOn.has('getPageTraffic')) { throw new Error('traffic backend exploded'); }
         return { pages: [], error: null };
      }),
   };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedKeywordFindAll.mockResolvedValue([]);
   mockedEventFindAll.mockResolvedValue([]);
   mockedGoalFindAll.mockResolvedValue([]);
   mockedGetProvider.mockReturnValue(providerStub());
});

describe('daily-brief route: auth, method, and input gates', () => {
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

describe('daily-brief route: ownership gate', () => {
   it('returns 403 and reads NO pillar data for a domain the caller does not own', async () => {
      mockedDomainFindOne.mockResolvedValue(null); // not owned
      const { req, res, captured } = makeReqRes({ domain: 'someone-elses.com' });
      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(captured.body.error).toMatch(/not found/i);
      expect(mockedKeywordFindAll).not.toHaveBeenCalled();
      expect(mockedEventFindAll).not.toHaveBeenCalled();
      expect(mockedGoalFindAll).not.toHaveBeenCalled();
   });
});

describe('daily-brief route: happy path', () => {
   it('returns 200 with a structured brief, a non-empty rendered block, and the period', async () => {
      mockedKeywordFindAll.mockResolvedValue([
         keywordRow({ keyword: 'masset', target_page: '/', curPos: 12, priorPos: 4 }), // page-one drop
      ]);
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      expect(captured.body.period).toBe('7d');
      expect(captured.body.brief).toBeDefined();
      expect(captured.body.brief.domain).toBe('getmasset.com');
      expect(typeof captured.body.rendered).toBe('string');
      expect(captured.body.rendered.length).toBeGreaterThan(0);
      // The rank drop surfaced as a change and drives the (non-quiet) brief.
      expect(captured.body.brief.quiet).toBe(false);
      const rankChange = captured.body.brief.whatChanged.find((c: any) => c.pillar === 'rank');
      expect(rankChange).toBeDefined();
   });

   it('defaults to a 7d period when none is supplied', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.period).toBe('7d');
   });

   it('returns an encouraging gathering brief for a brand-new domain with no keywords and no traffic', async () => {
      // No keywords + no events + no prior window = still gathering first data. The brief must
      // lead with "first check is running / first numbers coming in" copy, NOT a flat quiet/zero,
      // and steer the user to the setup steps (add keywords, install the script).
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.brief.dataState).toBe('gathering');
      expect(captured.body.brief.quiet).toBe(false);
      expect(captured.body.brief.whatChanged).toEqual([]);
      expect(captured.body.brief.headline).toMatch(/First check is running/);
      expect(captured.body.brief.headline).not.toMatch(/Quiet period/);
      expect(captured.body.brief.topAction).toMatch(/Add the keywords|tracking script/i);
   });
});

describe('daily-brief route: graceful degradation (never 500)', () => {
   it('still returns a usable 200 when the provider and several reads fail at once', async () => {
      mockedKeywordFindAll.mockRejectedValue(new Error('kw down'));
      mockedEventFindAll.mockRejectedValue(new Error('event down'));
      mockedGoalFindAll.mockRejectedValue(new Error('goal down'));
      mockedGetProvider.mockReturnValue(providerStub({ throwOn: new Set(['getSummary', 'getReferralSources', 'getPageTraffic']) }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', period: '7d' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.brief).toBeDefined();
      // Nothing measurable -> never a 500 and never a fabricated change. With no keywords, no
      // events, and no prior window the route reads this as the gathering (first-data) state and
      // returns an encouraging "first numbers are coming in" brief rather than a flat quiet/zero.
      expect(captured.body.brief.whatChanged).toEqual([]);
      expect(captured.body.brief.dataState).toBe('gathering');
      expect(captured.body.brief.quiet).toBe(false);
      expect(typeof captured.body.rendered).toBe('string');
   });
});
