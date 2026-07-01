/**
 * channel-report route: map first-party sessions to clean marketing channels and report sessions
 * (plus conversions when a goal is given) per channel. Mocks the models; the real sessionize +
 * channel-mapping logic runs.
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
import handler from '../../pages/api/channel-report';
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
   mockGoal.findOne.mockResolvedValue(
      row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix' }),
   );
   // A organic human -> converts; B ai human -> no; C referral(news.com) human -> no;
   // D referral(news.com) human -> converts; E direct human -> no; F organic BOT -> converts.
   mockEvent.findAll.mockResolvedValue([
      pv('A', 'organic-search', false, '/', '2026-06-16T10:00:00Z'),
      pv('A', 'organic-search', false, '/thanks', '2026-06-16T10:01:00Z'),
      pv('B', 'ai', false, '/', '2026-06-16T10:02:00Z'),
      pv('C', 'news.com', false, '/', '2026-06-16T10:03:00Z'),
      pv('D', 'news.com', false, '/', '2026-06-16T10:04:00Z'),
      pv('D', 'news.com', false, '/thanks', '2026-06-16T10:05:00Z'),
      pv('E', 'direct', false, '/', '2026-06-16T10:06:00Z'),
      pv('F', 'organic-search', true, '/thanks', '2026-06-16T10:07:00Z'),
   ]);
});

const byCode = (channels: any[], code: string) => channels.find((c) => c.channel === code);

describe('GET /api/channel-report', () => {
   it('maps sessions to clean channel labels and counts human-only sessions per channel', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      // 5 human sessions (A organic, B ai, C+D referral, E direct); F is a bot, excluded.
      expect(res.payload.report.totalSessions).toBe(5);
      expect(res.payload.botSessionsExcluded).toBe(1);
      expect(res.payload.report.hasGoal).toBe(false);

      const ch = res.payload.report.channels;
      expect(byCode(ch, 'organic-search').label).toBe('Organic Search');
      expect(byCode(ch, 'ai').label).toBe('AI Search');
      expect(byCode(ch, 'referral').label).toBe('Referral');
      expect(byCode(ch, 'direct').label).toBe('Direct');
      expect(byCode(ch, 'referral').sessions).toBe(2); // C, D
      // No goal supplied, so no conversion fields.
      expect(byCode(ch, 'organic-search').conversions).toBeUndefined();
   });

   it('emits channels in the stable marketer-reading order', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const codes = res.payload.report.channels.map((c: any) => c.channel);
      expect(codes).toEqual(['organic-search', 'ai', 'referral', 'direct']);
   });

   it('surfaces top referring hosts within the Referral channel', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const top = res.payload.report.topReferralSources;
      expect(top).toEqual([{ source: 'news.com', sessions: 2 }]); // C and D
   });

   it('adds per-channel conversions and rate when a goal is supplied', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.payload.goal).toEqual({ id: 1, name: 'Demo' });
      expect(res.payload.report.hasGoal).toBe(true);
      expect(res.payload.report.conversions).toBe(2); // A organic, D referral
      const ch = res.payload.report.channels;
      expect(byCode(ch, 'organic-search').conversionRatePct).toBe(100); // A converts of 1
      expect(byCode(ch, 'referral').conversionRatePct).toBe(50); // D of C+D
      expect(byCode(ch, 'ai').conversionRatePct).toBe(0);
   });

   it('includeBots folds the bot session back in', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', includeBots: 'true' }), res);
      expect(res.payload.report.totalSessions).toBe(6); // A-F
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
