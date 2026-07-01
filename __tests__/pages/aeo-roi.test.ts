/**
 * aeo-roi route: "The AI Visibility P&L". The cross-pillar join AI-referred traffic -> conversions ->
 * revenue, per page. Mocks the models; the real sessionize + buildAeoRoi logic runs.
 *
 * Also exercises the pure util directly for the honest-zero-baseline guarantee.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/aeo-roi';
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
// eslint-disable-next-line import/first
import { buildAeoRoi } from '../../utils/aeo-roi';
// eslint-disable-next-line import/first
import type { GoalDef } from '../../utils/sessionize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockGoal = GoalModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const goalRow = (over: Record<string, unknown> = {}) =>
   row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix', ...over });
// A pageview event row (sessionize reads these; the route filters bots out post-sessionize).
const pv = (session: string, source: string, page: string, created: string, is_bot = false) =>
   row({ session, source, is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makePost = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'POST', query, body: {}, headers: {} } as unknown as NextApiRequest);
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
   mockKeyword.findAll.mockResolvedValue([row({ keyword: 'ai dam', target_page: '/demo' })]);
   mockEvent.findAll.mockResolvedValue([]);
});

describe('GET /api/aeo-roi', () => {
   it('empty store: coherent "no AI activity yet" note, no NaN, no fabricated rate', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      const roi = res.payload.aeoRoi;
      expect(roi.totalAiSessions).toBe(0);
      expect(roi.aiConversions).toBe(0);
      expect(roi.totalAiRevenue).toBeNull();
      expect(roi.opportunities).toEqual([]); // never fires off a zero baseline
      expect(roi.note).toMatch(/No AI activity in this window/);
      // The tracked keyword's page still appears as honest 0-activity context, with a 0 (not NaN) rate.
      const demo = roi.byPage.find((p: any) => p.page === '/demo');
      expect(demo).toBeTruthy();
      expect(Number.isNaN(demo.aiConversionRatePct)).toBe(false);
      expect(demo.aiConversionRatePct).toBe(0);
   });

   it('seeded store: correct per-page funnel and revenue', async () => {
      mockGoal.findOne.mockResolvedValue(goalRow({ value: 250 }));
      // /demo: AI session D lands and converts (/thanks).
      mockEvent.findAll.mockResolvedValue([
         pv('D', 'ai', '/demo', '2026-06-16T10:00:00Z'),
         pv('D', 'ai', '/thanks', '2026-06-16T10:01:00Z'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(200);
      const roi = res.payload.aeoRoi;
      expect(roi.totalAiSessions).toBe(1);
      expect(roi.aiConversions).toBe(1);
      expect(roi.totalAiRevenue).toBe(250); // 1 conversion * 250
      const demo = roi.byPage.find((p: any) => p.page === '/demo');
      expect(demo.aiReferredSessions).toBe(1);
      expect(demo.aiConversions).toBe(1);
      expect(demo.revenue).toBe(250);
   });

   it('403 when the domain is not owned', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'notmine.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400 without a goal selector', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(400);
   });

   it('400 on a non-numeric goalId', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goalId: 'abc' }), res);
      expect(res.statusCode).toBe(400);
   });

   it('404 when the goal does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('405 on a non-GET method', async () => {
      const res = makeRes();
      await handler(makePost({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.statusCode).toBe(405);
   });
});

describe('buildAeoRoi (pure)', () => {
   const goal: GoalDef = { kind: 'page_reached', matchValue: '/thanks', matchPage: null, matchMode: 'prefix' };
   const sess = (id: string, channel: string, landingPage: string, pages: string[]): any => ({
      id,
      channel,
      isBot: false,
      device: 'desktop',
      country: 'US',
      landingPage,
      exitPage: pages[pages.length - 1],
      pageviewPaths: pages,
      eventTypes: new Set(['pageview']),
      pageEvents: [],
      pageviewCount: pages.length,
      hasNonPageviewEvent: false,
   });

   it('stays silent on a zero baseline (no opportunities, no NaN)', () => {
      const roi = buildAeoRoi([], goal, [{ keyword: 'k', targetPage: '/demo' }], 100);
      expect(roi.opportunities).toEqual([]);
      expect(roi.totalAiRevenue).toBe(0); // value set, but 0 conversions => 0, never NaN
      expect(roi.byPage.every((p) => !Number.isNaN(p.aiConversionRatePct) && !Number.isNaN(p.organicConversionRatePct))).toBe(true);
      expect(roi.note).toMatch(/No AI activity/);
   });

   it('fires ai-outconverts-organic only with real samples on both sides', () => {
      const sessions = [
         // /demo: 3 AI sessions, 2 convert (~66.7%); 3 organic, 0 convert (0%). Gap clears the floor.
         sess('a1', 'ai', '/demo', ['/demo', '/thanks']),
         sess('a2', 'ai', '/demo', ['/demo', '/thanks']),
         sess('a3', 'ai', '/demo', ['/demo']),
         sess('o1', 'organic-search', '/demo', ['/demo']),
         sess('o2', 'organic-search', '/demo', ['/demo']),
         sess('o3', 'organic-search', '/demo', ['/demo']),
      ];
      const roi = buildAeoRoi(sessions, goal, [], null);
      const opp = roi.opportunities.find((o) => o.type === 'ai-outconverts-organic' && o.page === '/demo');
      expect(opp).toBeTruthy();
      expect(roi.totalAiRevenue).toBeNull(); // value-less goal => no money anywhere
   });

   it('fires cited-not-converting on >=3 AI sessions with zero conversions', () => {
      const sessions = [
         sess('a1', 'ai', '/blog', ['/blog']),
         sess('a2', 'ai', '/blog', ['/blog']),
         sess('a3', 'ai', '/blog', ['/blog']),
      ];
      const roi = buildAeoRoi(sessions, goal, [], null);
      const opp = roi.opportunities.find((o) => o.type === 'cited-not-converting' && o.page === '/blog');
      expect(opp).toBeTruthy();
   });
});
