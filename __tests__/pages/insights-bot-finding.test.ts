/**
 * insights route: the cross-pillar bot finding must be computed from the
 * FIRST-PARTY is_bot split (pages/api/insights.ts).
 *
 * Finding #8 fix: insights.ts now fetches + sessionizes first-party S33kEvent rows
 * and passes them to estimateHumanTraffic, so the bot_traffic_* finding reflects the
 * canonical human/bot split (the same number human_traffic / human_analytics /
 * start_here / the dashboard report) instead of the honest-degraded shape
 * (estVisitors 0), which would suppress the finding or, on the provider path, falsely
 * read "0% bots".
 *
 * Contract under test:
 *   1. With first-party events present, insights surfaces a bot finding computed from
 *      the first-party split (estVisitors > 0).
 *   2. With NO first-party events, behavior is the prior degraded path: estVisitors 0
 *      and no bot finding (additive change, flag-off / no-data path unchanged).
 *   3. Auth (401) and missing-domain (400) guards still hold.
 *
 * All heavy deps (db, sequelize, Domain, Keyword, S33kEvent, authorize, the analytics
 * provider) are mocked. estimateHumanTraffic is NOT mocked here: it runs for real so
 * the first-party split is exercised end-to-end. No DB, no network, no LLM.
 */

import handler from '../../pages/api/insights';
import { getAnalyticsProvider } from '../../utils/analytics';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
// Mock sequelize so the route's `Op` import does not drag the real ORM into jest.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
// Mock the first-party events model so the route's sessionize fetch does not pull
// sequelize decorators into jest (same pattern as human-analytics.test.ts).
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

import authorize from '../../utils/authorize';
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedKeywordFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedEventFindAll = (S33kEvent as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

/** A first-party event DB-row stand-in: the route calls .get({ plain: true }). */
const eventRow = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const pageview = (session: string, isBot: boolean) => eventRow({
   session, page: '/', is_bot: isBot, created: '2026-06-16T10:00:00.000Z',
   type: 'pageview', source: 'direct', device: 'desktop', country: 'US',
});

/** A minimal Next-style GET req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query, headers: {}, url: '/api/insights' } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/** Provider stub. getSummary reports a bot-inflated visitor total to prove the
 *  first-party split (not the provider total) drives the bot finding. */
const providerStub = () => ({
   getPageTraffic: async () => ({ pages: [], error: null }),
   getReferralSources: async () => ({ sources: [], error: null }),
   getSummary: async () => ({ pageviews: 900, visitors: 724, bounceRate: 97, avgDuration: 2, pagesPerVisit: 1.0, error: null }),
});

beforeEach(() => {
   jest.clearAllMocks();
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedKeywordFindAll.mockResolvedValue([]);
   mockedGetProvider.mockReturnValue(providerStub());
   mockedEventFindAll.mockResolvedValue([]);
});

describe('GET /api/insights bot finding from first-party split', () => {
   it('surfaces a bot finding computed from the first-party split when events exist', async () => {
      // 2 human sessions (A, B) + 1 bot session (C). Bot share 33.3% (>= BOT_SHARE_WARN 30),
      // so the loud caveat fires; the numbers come from the first-party split, not 724.
      mockedEventFindAll.mockResolvedValue([
         pageview('A', false), pageview('B', false), pageview('C', true),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const botFinding = captured.body.findings.find((f: any) => /bot_traffic/.test(f.type));
      expect(botFinding).toBeDefined();
      expect(botFinding.evidence.estVisitors).toBe(3);
      expect(botFinding.evidence.estHumanVisitors).toBe(2);
      expect(botFinding.evidence.estBotVisitors).toBe(1);
      // 33.3% bots >= 30% warn threshold, so it is the high-severity caveat.
      expect(botFinding.type).toBe('bot_traffic_caveat');
   });

   it('does not surface a bot finding when there are no first-party events (degraded path unchanged)', async () => {
      // No events: estimateHumanTraffic degrades honestly (estVisitors 0), the same as
      // the pre-fix behavior, so neither bot finding fires. Additive change verified.
      mockedEventFindAll.mockResolvedValue([]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const botFinding = captured.body.findings.find((f: any) => /bot_traffic/.test(f.type));
      expect(botFinding).toBeUndefined();
   });

   it('returns 401 when the request is not authorized', async () => {
      mockedAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'This Route Requires a valid Authorization Bearer Token.' });
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(401);
   });

   it('returns 400 when the domain is missing', async () => {
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);
      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/domain/i);
   });
});
