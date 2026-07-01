/**
 * conversion-attribution route: the cross-pillar join with optional goal-value revenue. Mocks the
 * models; the real sessionize + attributeConversions logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/conversion-attribution';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockGoal = GoalModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
// Build a goal row, defaulting the match fields, so each mock only states what it varies (esp. value).
const goalRow = (over: Record<string, unknown> = {}) =>
   row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix', ...over });
const pv = (session: string, source: string, page: string, created: string) =>
   row({ session, source, is_bot: false, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockGoal.findOne.mockResolvedValue(goalRow());
   mockKeyword.findAll.mockResolvedValue([row({ keyword: 'book a demo', position: 0, target_page: '/demo' })]);
   // D lands /demo via AI and converts on /thanks; E lands /demo via AI and does not.
   mockEvent.findAll.mockResolvedValue([
      pv('D', 'ai', '/demo', '2026-06-16T10:00:00Z'),
      pv('D', 'ai', '/thanks', '2026-06-16T10:01:00Z'),
      pv('E', 'ai', '/demo', '2026-06-16T10:02:00Z'),
   ]);
});

describe('GET /api/conversion-attribution', () => {
   it('attributes conversions and omits revenue when the goal has no value', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.attribution.conversions).toBe(1); // only D
      expect(res.payload.attribution.goalValue).toBeNull();
      expect(res.payload.attribution.totalRevenue).toBeNull();
      expect(res.payload.goal.value).toBeNull();
   });

   it('adds revenue (conversions * value) when the goal has a value', async () => {
      mockGoal.findOne.mockResolvedValue(goalRow({ value: 250 }));
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.attribution.goalValue).toBe(250);
      expect(res.payload.attribution.totalRevenue).toBe(250); // 1 conversion * 250
      expect(res.payload.goal.value).toBe(250);
      expect(res.payload.attribution.byKeyword.find((k: any) => k.keyword === 'book a demo').revenue).toBe(250);
   });

   it('400s without a goal selector', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(400);
   });

   it('404s when the goal does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });
});
