/** onboarding-status: setup checklist + next step. */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { count: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { count: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { count: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
// setupState pulls the settings store (sequelize models) in; mock the one read the route makes.
// Default: SEO enabled (a scraper key configured), the legacy shape every existing case assumes.
jest.mock('../../utils/setupState', () => ({ __esModule: true, isSeoConfigured: jest.fn(async () => true) }));

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
// eslint-disable-next-line import/first
import { isSeoConfigured } from '../../utils/setupState';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { count: jest.Mock };
const mockEvent = S33kEventModel as unknown as { count: jest.Mock };
const mockGoal = GoalModel as unknown as { count: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockSeoConfigured = isSeoConfigured as unknown as jest.Mock;

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
   mockSeoConfigured.mockResolvedValue(true);
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

describe('GET /api/onboarding-status with the SEO module OFF (modular pillars)', () => {
   it('a KEYLESS instance with flowing analytics + a goal reads COMPLETE, with modules naming SEO as off', async () => {
      mockSeoConfigured.mockResolvedValue(false);
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'x.com' }));
      mockKeyword.count.mockResolvedValue(0);
      mockEvent.count.mockResolvedValue(80);
      mockGoal.count.mockResolvedValue(1);
      const res = makeRes();
      await handler(makeReq({ domain: 'x.com' }), res);
      // HEALTHY: 100% complete without any keywords, because SEO is an optional off module.
      expect(res.payload.percentComplete).toBe(100);
      expect(res.payload.nextStep).toBeNull();
      expect(res.payload.steps.map((s2: any) => s2.key)).not.toContain('track_keywords');
      const byKey: Record<string, any> = {};
      res.payload.modules.forEach((m: any) => { byKey[m.key] = m; });
      expect(byKey.analytics.status).toBe('live');
      expect(byKey.ai_referrals.status).toBe('live');
      expect(byKey.seo.status).toBe('not_enabled');
      expect(byKey.seo.enable).toContain('mint_key_drop');
      // The message names the enablement path instead of reading as missing setup.
      expect(res.payload.message).toContain('key-drop');
   });

   it('a KEYED instance reports the SEO module enabled and keeps the five-step checklist', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'x.com' }));
      mockKeyword.count.mockResolvedValue(5);
      mockEvent.count.mockResolvedValue(100);
      mockGoal.count.mockResolvedValue(2);
      const res = makeRes();
      await handler(makeReq({ domain: 'x.com' }), res);
      expect(res.payload.percentComplete).toBe(100);
      expect(res.payload.steps.map((s2: any) => s2.key)).toContain('track_keywords');
      expect(res.payload.modules.find((m: any) => m.key === 'seo').status).toBe('enabled');
   });

   it('a truly fresh keyless instance still walks setup from add-site', async () => {
      mockSeoConfigured.mockResolvedValue(false);
      mockDomain.findOne.mockResolvedValue(null);
      mockKeyword.count.mockResolvedValue(0);
      mockEvent.count.mockResolvedValue(0);
      mockGoal.count.mockResolvedValue(0);
      const res = makeRes();
      await handler(makeReq({ domain: 'new.com' }), res);
      expect(res.payload.percentComplete).toBe(0);
      expect(res.payload.nextStep.key).toBe('add_domain');
      expect(res.payload.modules.find((m: any) => m.key === 'analytics').status).toBe('waiting_for_beacon');
   });
});
