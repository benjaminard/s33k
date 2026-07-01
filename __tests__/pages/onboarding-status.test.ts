/** onboarding-status: setup checklist + next step. */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { count: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { count: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { count: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/onboarding-status';
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

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { count: jest.Mock };
const mockEvent = S33kEventModel as unknown as { count: jest.Mock };
const mockGoal = GoalModel as unknown as { count: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (d: Record<string, unknown>) => ({ get: () => d, ...d });
const makeReq = (q: Record<string, string>): NextApiRequest => ({ method: 'GET', query: q, body: {}, headers: {} } as unknown as NextApiRequest);
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
});

describe('GET /api/onboarding-status', () => {
   it('reports a brand-new domain as 0% with add-site as the next step', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockKeyword.count.mockResolvedValue(0);
      mockEvent.count.mockResolvedValue(0);
      mockGoal.count.mockResolvedValue(0);
      const res = makeRes();
      await handler(makeReq({ domain: 'new.com' }), res);
      expect(res.payload.percentComplete).toBe(0);
      expect(res.payload.nextStep.key).toBe('add_domain');
   });

   it('advances the next step as pieces are completed', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'x.com' }));
      mockKeyword.count.mockResolvedValue(5);
      mockEvent.count.mockResolvedValue(0); // tracking not live yet
      mockGoal.count.mockResolvedValue(0);
      const res = makeRes();
      await handler(makeReq({ domain: 'x.com' }), res);
      expect(res.payload.nextStep.key).toBe('install_tracking');
      expect(res.payload.steps.find((s: any) => s.key === 'track_keywords').done).toBe(true);
   });

   it('reports complete when every step is done', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'x.com' }));
      mockKeyword.count.mockResolvedValue(5);
      mockEvent.count.mockResolvedValue(100);
      mockGoal.count.mockResolvedValue(2);
      const res = makeRes();
      await handler(makeReq({ domain: 'x.com' }), res);
      expect(res.payload.percentComplete).toBe(100);
      expect(res.payload.nextStep).toBeNull();
   });
});
