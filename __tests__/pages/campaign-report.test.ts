/**
 * campaign-report route: group first-party sessions by utm_campaign and report sessions (plus
 * conversions when a goal is given) per campaign, with breakdowns by utm_source and utm_medium.
 * Mocks the models; the real sessionize + campaign-rollup logic runs.
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
import handler from '../../pages/api/campaign-report';
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
type Utm = { utm_source: string | null, utm_medium: string | null, utm_campaign: string | null };
const pv = (session: string, is_bot: boolean, page: string, created: string, utm: Utm) =>
   row({ session, source: 'direct', is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created, ...utm });

const makeReq = (query: Record<string, string>): NextApiRequest => ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

const byCampaign = (campaigns: any[], name: string) => campaigns.find((c) => c.campaign === name);
const byValue = (rows: any[], value: string) => rows.find((r) => r.value === value);

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockGoal.findOne.mockResolvedValue(
      row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix' }),
   );
   // A spring/google/cpc human -> converts; B spring/google/cpc human -> no;
   // C summer/newsletter/email human -> converts; D untagged human -> no; E spring BOT -> converts.
   const spring = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring' };
   const summer = { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'summer' };
   const none = { utm_source: null, utm_medium: null, utm_campaign: null };
   mockEvent.findAll.mockResolvedValue([
      pv('A', false, '/', '2026-06-16T10:00:00Z', spring),
      pv('A', false, '/thanks', '2026-06-16T10:01:00Z', spring),
      pv('B', false, '/', '2026-06-16T10:02:00Z', spring),
      pv('C', false, '/', '2026-06-16T10:03:00Z', summer),
      pv('C', false, '/thanks', '2026-06-16T10:04:00Z', summer),
      pv('D', false, '/', '2026-06-16T10:05:00Z', none),
      pv('E', true, '/thanks', '2026-06-16T10:06:00Z', spring),
   ]);
});

describe('GET /api/campaign-report', () => {
   it('groups human-only sessions by utm_campaign and counts sessions per campaign', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      // 4 human sessions (A, B spring; C summer; D untagged); E is a bot, excluded.
      expect(res.payload.report.totalSessions).toBe(4);
      expect(res.payload.botSessionsExcluded).toBe(1);
      expect(res.payload.report.hasGoal).toBe(false);

      const cs = res.payload.report.campaigns;
      expect(byCampaign(cs, 'spring').sessions).toBe(2); // A, B
      expect(byCampaign(cs, 'summer').sessions).toBe(1); // C
      expect(byCampaign(cs, '(none)').sessions).toBe(1); // D untagged
      // No goal supplied, so no conversion fields.
      expect(byCampaign(cs, 'spring').conversions).toBeUndefined();
   });

   it('always orders the untagged "(none)" bucket last', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const names = res.payload.report.campaigns.map((c: any) => c.campaign);
      expect(names[names.length - 1]).toBe('(none)');
   });

   it('breaks down sessions by utm_source and utm_medium', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const { bySource, byMedium } = res.payload.report;
      expect(byValue(bySource, 'google').sessions).toBe(2); // A, B
      expect(byValue(bySource, 'newsletter').sessions).toBe(1); // C
      expect(byValue(bySource, '(none)').sessions).toBe(1); // D
      expect(byValue(byMedium, 'cpc').sessions).toBe(2); // A, B
      expect(byValue(byMedium, 'email').sessions).toBe(1); // C
   });

   it('adds per-campaign conversions and rate when a goal is supplied', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.payload.goal).toEqual({ id: 1, name: 'Demo' });
      expect(res.payload.report.hasGoal).toBe(true);
      expect(res.payload.report.conversions).toBe(2); // A spring, C summer
      const cs = res.payload.report.campaigns;
      expect(byCampaign(cs, 'spring').conversionRatePct).toBe(50); // A of A+B
      expect(byCampaign(cs, 'summer').conversionRatePct).toBe(100); // C of 1
      expect(byCampaign(cs, '(none)').conversionRatePct).toBe(0); // D of 1
   });

   it('includeBots folds the bot session back in', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', includeBots: 'true' }), res);
      expect(res.payload.report.totalSessions).toBe(5); // A-E
      expect(res.payload.botSessionsExcluded).toBe(0);
   });

   it('403s when the domain is not owned by the account', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'notmine.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('404s when a goal name is given but does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });
});
