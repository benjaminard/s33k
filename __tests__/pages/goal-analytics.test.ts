/**
 * goal-analytics route: conversion rate for a named goal, with human-only default, channel
 * filtering, and groupBy. Mocks the models; the real sessionize/goal logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/goal-analytics';
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

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
// Build a goal row, defaulting the match fields, so each mock only states what it varies (esp. value).
const goalRow = (over: Record<string, unknown> = {}) =>
   row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix', ...over });
const pv = (session: string, source: string, is_bot: boolean, page: string, created: string) =>
   row({ session, source, is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>): NextApiRequest => ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
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
   // A organic-search human -> converts; B ai human -> no; C direct human -> converts; D organic BOT -> converts.
   mockEvent.findAll.mockResolvedValue([
      pv('A', 'organic-search', false, '/', '2026-06-16T10:00:00Z'),
      pv('A', 'organic-search', false, '/thanks', '2026-06-16T10:01:00Z'),
      pv('B', 'ai', false, '/', '2026-06-16T10:02:00Z'),
      pv('C', 'direct', false, '/', '2026-06-16T10:03:00Z'),
      pv('C', 'direct', false, '/thanks', '2026-06-16T10:04:00Z'),
      pv('D', 'organic-search', true, '/thanks', '2026-06-16T10:05:00Z'),
   ]);
});

describe('GET /api/goal-analytics', () => {
   it('computes human-only conversion rate and excludes the bot session', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.totalSessions).toBe(3); // A, B, C (D is bot, excluded)
      expect(res.payload.conversions).toBe(2); // A, C
      expect(res.payload.conversionRatePct).toBe(66.7);
      expect(res.payload.botSessionsExcluded).toBe(1);
   });

   it('groupBy=channel breaks the rate down by source', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo', groupBy: 'channel' }), res);
      const { groups }: { groups: any[] } = res.payload;
      expect(groups.find((g) => g.key === 'organic-search').conversionRatePct).toBe(100);
      expect(groups.find((g) => g.key === 'ai').conversionRatePct).toBe(0);
      expect(groups.find((g) => g.key === 'direct').conversionRatePct).toBe(100);
   });

   it('channel filter restricts to that source (how many AI referrals converted)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo', channel: 'aio' }), res);
      expect(res.payload.totalSessions).toBe(1); // only B
      expect(res.payload.conversions).toBe(0);
   });

   it('includeBots folds the bot session back in', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo', includeBots: 'true' }), res);
      expect(res.payload.totalSessions).toBe(4); // A, B, C, D
      expect(res.payload.conversions).toBe(3); // A, C, D
   });

   it('404s when the goal does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('omits revenue when the goal has no value (unchanged shape)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.payload.goalValue).toBeNull();
      expect(res.payload.totalRevenue).toBeNull();
      expect(res.payload.goal.value).toBeNull();
   });

   it('reports revenue (conversions * value) when the goal has a value', async () => {
      mockGoal.findOne.mockResolvedValue(goalRow({ value: 250 }));
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.payload.conversions).toBe(2);
      expect(res.payload.goalValue).toBe(250);
      expect(res.payload.totalRevenue).toBe(500); // 2 conversions * 250
      expect(res.payload.goal.value).toBe(250);
   });

   it('adds per-group revenue with groupBy when the goal has a value', async () => {
      mockGoal.findOne.mockResolvedValue(goalRow({ value: 100 }));
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo', groupBy: 'channel' }), res);
      const { groups }: { groups: any[] } = res.payload;
      expect(groups.find((g) => g.key === 'organic-search').revenue).toBe(100); // 1 conversion * 100
      expect(groups.find((g) => g.key === 'ai').revenue).toBe(0); // 0 conversions
   });
});
