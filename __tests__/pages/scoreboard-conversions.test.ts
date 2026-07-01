/**
 * Tests for the OPTIONAL per-page conversions on page_scoreboard (pages/api/scoreboard.ts).
 *
 * The scoreboard joins per-page traffic to tracked keywords. When the caller passes a goal (name or
 * goalId), every page row gains conversions (goal conversions whose first-party session LANDED on
 * that page) and conversionRate (over first-party sessions that landed there, percent). This is an
 * ADDITIVE enhancement: omitting the goal leaves the response byte-for-byte unchanged (no conversion
 * fields). The contracts under test:
 *
 *   1. No goal -> no conversion fields anywhere, goal meta is null (unchanged behavior).
 *   2. With a goal -> each page carries conversions attributed by LANDING page + a conversionRate
 *      over first-party landing sessions, and goal meta is echoed.
 *   3. A page with no first-party landing sessions reports conversionRate null.
 *   4. A bad goalId 400s; an unknown goal name 404s; both before any traffic read.
 *
 * The heavy deps (db, Domain, Goal, Keyword, S33kEvent, authorize, provider) are mocked so the
 * handler's conversion-attribution logic is exercised in isolation.
 */

import handler from '../../pages/api/scoreboard';
import { getAnalyticsProvider } from '../../utils/analytics';
import Keyword from '../../database/models/keyword';

jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

import authorize from '../../utils/authorize';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import S33kEvent from '../../database/models/s33kEvent';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedGoalFindOne = (Goal as unknown as { findOne: jest.Mock }).findOne;
const mockedFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedEventFindAll = (S33kEvent as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

const keywordRow = (overrides: Record<string, unknown>) => {
   const plain = {
      ID: 1, keyword: 'masset', domain: 'getmasset.com', device: 'desktop', country: 'US',
      position: 1, url: 'https://getmasset.com/', target_page: '/', history: '{}', tags: '[]',
      lastResult: '[]', lastUpdateError: 'false', sticky: false, ...overrides,
   };
   return { get: () => plain };
};

/** A s33k_event DB-row stand-in: the route calls .get({ plain: true }) on each row. */
const eventRow = (over: Record<string, unknown>) => {
   const plain = {
      id: 1, session: 's1', source: 'direct', is_bot: false, device: 'desktop', country: 'US',
      page: '/', type: 'pageview', created: '2026-06-18T00:00:00.000Z', ...over,
   };
   return { get: () => plain };
};

/** A goal DB-row stand-in: a page_reached goal that matches "/thank-you". */
const goalRow = (over: Record<string, unknown> = {}) => {
   const plain = {
      ID: 7, name: 'demo-request', domain: 'getmasset.com', kind: 'page_reached',
      match_value: '/thank-you', match_page: null, match_mode: 'prefix', ...over,
   };
   return { get: () => plain };
};

const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

const providerStub = (pages: any[]) => ({
   getPageTraffic: jest.fn(async () => ({ pages, error: null })),
   getReferralSources: jest.fn(async () => ({ sources: [], error: null })),
});

const pageRow = (over: Record<string, unknown> = {}) => ({
   url: 'https://getmasset.com/', pathClean: '/', page_views: 100, unique_visitors: 90,
   bounce_rate: 40, avg_duration: 30, ...over,
});

beforeEach(() => {
   jest.clearAllMocks();
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/' })]);
   mockedEventFindAll.mockResolvedValue([]);
   mockedGoalFindOne.mockResolvedValue(goalRow());
});

describe('page_scoreboard conversions: omitting the goal leaves behavior unchanged', () => {
   it('adds no conversion fields and null goal when no goal is supplied', async () => {
      mockedGetProvider.mockReturnValue(providerStub([pageRow({ pathClean: '/', page_views: 100 })]));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.goal).toBeNull();
      expect(captured.body.conversionsNote).toBeNull();
      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      expect(home).toBeDefined();
      expect(home.conversions).toBeUndefined();
      expect(home.conversionRate).toBeUndefined();
      // The goal model must not even be queried when no goal is asked for.
      expect(mockedGoalFindOne).not.toHaveBeenCalled();
   });
});

describe('page_scoreboard conversions: per-page attribution when a goal is given', () => {
   it('attributes conversions to the LANDING page and computes a rate over landing sessions', async () => {
      // Three sessions landed on /: two converted (reached /thank-you), one did not. One session
      // landed on /pricing and converted. The scoreboard page rows are keyed by clean path.
      mockedFindAll.mockResolvedValue([
         keywordRow({ ID: 1, keyword: 'masset', target_page: '/' }),
         keywordRow({ ID: 2, keyword: 'pricing', target_page: '/pricing' }),
      ]);
      mockedEventFindAll.mockResolvedValue([
         // session a: lands /, converts (sees /thank-you)
         eventRow({ id: 1, session: 'a', source: 'organic-search', page: '/', type: 'pageview' }),
         eventRow({ id: 2, session: 'a', source: 'organic-search', page: '/thank-you', type: 'pageview' }),
         // session b: lands /, converts
         eventRow({ id: 3, session: 'b', source: 'direct', page: '/', type: 'pageview' }),
         eventRow({ id: 4, session: 'b', source: 'direct', page: '/thank-you', type: 'pageview' }),
         // session c: lands /, does NOT convert
         eventRow({ id: 5, session: 'c', source: 'direct', page: '/', type: 'pageview' }),
         // session d: lands /pricing, converts
         eventRow({ id: 6, session: 'd', source: 'referral', page: '/pricing', type: 'pageview' }),
         eventRow({ id: 7, session: 'd', source: 'referral', page: '/thank-you', type: 'pageview' }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub([
         pageRow({ url: 'https://getmasset.com/', pathClean: '/', page_views: 100 }),
         pageRow({ url: 'https://getmasset.com/pricing', pathClean: '/pricing', page_views: 50 }),
      ]));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', goal: 'demo-request' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.goal).toEqual({ id: 7, name: 'demo-request' });
      expect(captured.body.conversionsNote).toMatch(/conversions/i);
      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      const pricing = captured.body.scoreboard.find((p: any) => p.pathClean === '/pricing');
      // / had 3 landing sessions, 2 converted -> 66.7%.
      expect(home.conversions).toBe(2);
      expect(home.conversionRate).toBe(66.7);
      // /pricing had 1 landing session, 1 converted -> 100%.
      expect(pricing.conversions).toBe(1);
      expect(pricing.conversionRate).toBe(100);
   });

   it('reports conversionRate null on a page with no first-party landing sessions', async () => {
      // The page gets provider traffic, but no first-party session landed on it.
      mockedEventFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub([pageRow({ pathClean: '/', page_views: 100 })]));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', goal: 'demo-request' });
      await handler(req, res);

      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      expect(home.conversions).toBe(0);
      expect(home.conversionRate).toBeNull();
   });

   it('resolves the goal by goalId too', async () => {
      mockedGoalFindOne.mockResolvedValue(goalRow({ ID: 42, name: 'video-form' }));
      mockedGetProvider.mockReturnValue(providerStub([pageRow({ pathClean: '/', page_views: 100 })]));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', goalId: '42' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.goal).toEqual({ id: 42, name: 'video-form' });
   });
});

describe('page_scoreboard conversions: goal resolution errors', () => {
   it('400s on a non-numeric goalId before any traffic read', async () => {
      const stub = providerStub([pageRow({ pathClean: '/', page_views: 100 })]);
      mockedGetProvider.mockReturnValue(stub);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', goalId: 'abc' });
      await handler(req, res);

      expect(captured.status).toBe(400);
      expect(stub.getPageTraffic).not.toHaveBeenCalled();
   });

   it('404s when the named goal does not exist', async () => {
      mockedGoalFindOne.mockResolvedValue(null);
      const stub = providerStub([pageRow({ pathClean: '/', page_views: 100 })]);
      mockedGetProvider.mockReturnValue(stub);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com', goal: 'nope' });
      await handler(req, res);

      expect(captured.status).toBe(404);
      expect(stub.getPageTraffic).not.toHaveBeenCalled();
   });
});
