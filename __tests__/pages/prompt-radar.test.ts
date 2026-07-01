/**
 * prompt-radar route: the AI-citation -> conversion join. Mocks the models; the real sessionize +
 * sessionConverted logic runs so the per-cited-page join is exercised end to end.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/promptCheck', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/prompt-radar';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import PromptCheckModel from '../../database/models/promptCheck';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockGoal = GoalModel as unknown as { findOne: jest.Mock };
const mockPC = PromptCheckModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const goalRow = (over: Record<string, unknown> = {}) =>
   row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix', ...over });
// A recorded, cited prompt row.
const cited = (over: Record<string, unknown> = {}) =>
   row({ ID: 10, prompt: 'best dam', engine: 'chatgpt', cited: true, position: 1, cited_url: '/software', checked_at: '2026-06-10', created: '2026-06-01', ...over });
// A pageview event row (sessionize reads these).
const pv = (session: string, source: string, page: string, created: string, is_bot = false) =>
   row({ session, source, is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>, method = 'GET'): NextApiRequest =>
   ({ method, query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

const now = new Date().toJSON();

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockGoal.findOne.mockResolvedValue(goalRow());
   mockPC.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
});

describe('/api/prompt-radar', () => {
   it('403s on an unowned domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s without a domain', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }, 'POST'), res);
      expect(res.statusCode).toBe(405);
   });

   it('is honest when no prompt results are recorded yet', async () => {
      mockPC.findAll.mockResolvedValue([row({ ID: 1, prompt: 'x', checked_at: null, cited: null })]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.summary.citedPrompts).toBe(0);
      expect(res.payload.note).toMatch(/no prompt results recorded yet/i);
      expect(res.payload.moneyInsight).toMatch(/record/i);
   });

   it('joins a recorded citation to its cited page conversion + AI-referral data', async () => {
      // The cited prompt points at /software. Two AI sessions land on /software, one of them also
      // reaches the goal page /thanks (so it converts the page_reached goal).
      mockPC.findAll.mockResolvedValue([cited()]);
      mockEvent.findAll.mockResolvedValue([
         pv('s1', 'ai', '/software', now),
         pv('s1', 'ai', '/thanks', now),
         pv('s2', 'ai', '/software', now),
         pv('s3', 'direct', '/other', now),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.summary.citedPrompts).toBe(1);
      const radarRow = res.payload.citedFor[0];
      expect(radarRow.citedUrl).toBe('/software');
      // Two AI sessions landed on /software; one converted.
      expect(radarRow.aiReferralSessions).toBe(2);
      expect(radarRow.landingSessions).toBe(2);
      expect(radarRow.conversions).toBe(1);
      expect(radarRow.conversionRatePct).toBe(50);
      expect(res.payload.moneyInsight).toMatch(/best-converting cited page is \/software/i);
   });

   it('reports cited-but-no-conversion honestly when cited pages do not convert', async () => {
      mockPC.findAll.mockResolvedValue([cited()]);
      // AI sessions land on /software but none reach /thanks, so the goal does not convert.
      mockEvent.findAll.mockResolvedValue([
         pv('s1', 'ai', '/software', now),
         pv('s2', 'ai', '/software', now),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.citedFor[0].conversions).toBe(0);
      expect(res.payload.moneyInsight).toMatch(/none of the cited pages converted/i);
   });

   it('reports zero-cited honestly when results exist but none cited', async () => {
      mockPC.findAll.mockResolvedValue([row({ ID: 2, prompt: 'p', engine: 'gemini', cited: false, checked_at: '2026-06-10' })]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.summary.citedPrompts).toBe(0);
      expect(res.payload.uncited).toHaveLength(1);
      expect(res.payload.moneyInsight).toMatch(/cited in 0 of/i);
   });

   it('404s when a named goal is not found', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('works without a goal (citation view only, no conversion numbers)', async () => {
      mockPC.findAll.mockResolvedValue([cited()]);
      mockEvent.findAll.mockResolvedValue([pv('s1', 'ai', '/software', now)]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.citedFor[0].conversions).toBeNull();
      expect(res.payload.moneyInsight).toMatch(/pass a goal/i);
   });
});
