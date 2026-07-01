/**
 * period-compare route: side-by-side metrics for a window vs the immediately-preceding equal-length
 * window, with delta and pctChange per metric. Mocks the models + authorize; the real
 * buildPeriodCompare / computeWindowMetrics / sessionize logic runs.
 *
 * Time control: the route derives both windows from Date.now(), so the test pins Date.now to a fixed
 * instant and dates the mocked events relative to it (current window vs prior window) so the split is
 * deterministic.
 */
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/period-compare';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockGoal = GoalModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

// A fixed "now" so the 30d current window is [NOW-30d, NOW] and the prior is [NOW-60d, NOW-30d].
const NOW = Date.parse('2026-06-16T00:00:00.000Z');
const DAY = 86400e3;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toJSON();

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
// One event row. type defaults to 'pageview'; is_bot defaults false.
const ev = (session: string, created: string, extra: Record<string, unknown> = {}) => row({
   session, created, source: extra.source ?? null, is_bot: extra.is_bot ?? false,
   device: 'desktop', country: 'US', page: extra.page ?? '/', type: extra.type ?? 'pageview',
});

const makeReq = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

let nowSpy: jest.SpyInstance;

beforeEach(() => {
   jest.clearAllMocks();
   nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockGoal.findOne.mockResolvedValue(null);

   // CURRENT window (within last 30d): 3 sessions.
   //  - sCurA: 2 pageviews -> engaged (not a bounce), reaches /pricing (goal page).
   //  - sCurB: 1 pageview, no other event -> bounce.
   //  - sCurC: 1 pageview + a 'signup' event -> engaged (not a bounce).
   // PRIOR window (30d..60d ago): 2 sessions.
   //  - sPriA: 1 pageview -> bounce.
   //  - sPriB: 2 pageviews -> engaged, reaches /pricing.
   mockEvent.findAll.mockResolvedValue([
      ev('sCurA', daysAgo(2), { page: '/' }),
      ev('sCurA', daysAgo(2), { page: '/pricing' }),
      ev('sCurB', daysAgo(5), { page: '/' }),
      ev('sCurC', daysAgo(8), { page: '/' }),
      ev('sCurC', daysAgo(8), { page: '/', type: 'signup' }),
      ev('sPriA', daysAgo(40), { page: '/' }),
      ev('sPriB', daysAgo(45), { page: '/' }),
      ev('sPriB', daysAgo(45), { page: '/pricing' }),
   ]);
});

afterEach(() => { nowSpy.mockRestore(); });

const find = (payload: any, metric: string) => payload.report.deltas.find((d: any) => d.metric === metric);

describe('GET /api/period-compare', () => {
   it('computes each window\'s metrics and the per-metric delta + pctChange', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);
      expect(res.statusCode).toBe(200);

      // Current: 3 visitors, 4 pageviews (2+1+1), 1 bounce of 3 -> 33.3%.
      expect(res.payload.report.current.metrics.humanVisitors).toBe(3);
      expect(res.payload.report.current.metrics.pageviews).toBe(4);
      expect(res.payload.report.current.metrics.bounceRatePct).toBe(33.3);
      // Prior: 2 visitors, 3 pageviews (1+2), 1 bounce of 2 -> 50%.
      expect(res.payload.report.prior.metrics.humanVisitors).toBe(2);
      expect(res.payload.report.prior.metrics.pageviews).toBe(3);
      expect(res.payload.report.prior.metrics.bounceRatePct).toBe(50);

      // Deltas: visitors 3 vs 2 -> +1, +50%. pageviews 4 vs 3 -> +1, +33.3%.
      expect(find(res.payload, 'humanVisitors')).toMatchObject({ current: 3, prior: 2, delta: 1, pctChange: 50 });
      expect(find(res.payload, 'pageviews')).toMatchObject({ current: 4, prior: 3, delta: 1, pctChange: 33.3 });
   });

   it('windows the prior-period query bounds correctly (both windows pulled, then split)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);
      // current window ends at NOW, prior window ends where current begins (no gap/overlap).
      expect(res.payload.report.current.endMs).toBe(NOW);
      expect(res.payload.report.current.startMs).toBe(res.payload.report.prior.endMs);
      expect(res.payload.report.current.startMs - res.payload.report.prior.startMs)
         .toBe(NOW - res.payload.report.current.startMs); // equal-length windows
   });

   it('adds conversion metrics when a goal is supplied (page_reached /pricing)', async () => {
      mockGoal.findOne.mockResolvedValue(row({
         ID: 7, name: 'Pricing Viewed', kind: 'page_reached', match_value: '/pricing', match_page: null, match_mode: 'prefix',
      }));
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d', goal: 'Pricing Viewed' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.goal).toEqual({ id: 7, name: 'Pricing Viewed' });
      // Current: only sCurA reached /pricing -> 1 of 3 = 33.3%. Prior: only sPriB -> 1 of 2 = 50%.
      expect(res.payload.report.current.metrics.conversions).toBe(1);
      expect(res.payload.report.prior.metrics.conversions).toBe(1);
      expect(find(res.payload, 'conversions')).toMatchObject({ current: 1, prior: 1, delta: 0, pctChange: 0 });
      expect(find(res.payload, 'conversionRatePct')).toMatchObject({ current: 33.3, prior: 50 });
   });

   it('returns null pctChange when the prior window is empty (undefined growth from zero)', async () => {
      mockEvent.findAll.mockResolvedValue([
         ev('sCurA', daysAgo(2), { page: '/' }), // current only, no prior-window events
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);
      expect(res.payload.report.prior.metrics.humanVisitors).toBe(0);
      expect(find(res.payload, 'humanVisitors')).toMatchObject({ current: 1, prior: 0, pctChange: null });
   });

   it('excludes bot sessions by default and reports the count across both windows', async () => {
      mockEvent.findAll.mockResolvedValue([
         ev('sHuman', daysAgo(3), { page: '/' }),
         ev('sBotCur', daysAgo(4), { page: '/', is_bot: true }),
         ev('sBotPri', daysAgo(50), { page: '/', is_bot: true }),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);
      expect(res.payload.botSessionsExcluded).toBe(2); // one bot in each window
      expect(res.payload.report.current.metrics.humanVisitors).toBe(1);
      expect(res.payload.report.prior.metrics.humanVisitors).toBe(0);
   });

   it('404s when a named goal does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });
});
