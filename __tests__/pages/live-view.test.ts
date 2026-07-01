/**
 * live-view route: a polled real-time snapshot of the last N minutes. Mocks the models and
 * authorize; the real window/tally/sessionize-channel logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/live-view';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const ev = (session: string, source: string, is_bot: boolean, page: string, type: string, country: string, created: string) =>
   row({ session, source, is_bot, device: 'desktop', country, page, type, created });

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
   // Rows ordered newest-first, as the route asks the DB for (created DESC).
   // Humans: A (organic /pricing pageview), A (click on /pricing), B (ai /pricing pageview),
   //         C (direct / pageview). Bot: D (organic /pricing pageview).
   mockEvent.findAll.mockResolvedValue([
      ev('D', 'organic-search', true, '/pricing', 'pageview', 'US', '2026-06-16T10:04:50Z'),
      ev('C', 'direct', false, '/', 'pageview', 'GB', '2026-06-16T10:04:40Z'),
      ev('B', 'ai', false, '/pricing', 'pageview', 'US', '2026-06-16T10:04:30Z'),
      ev('A', 'organic-search', false, '/pricing', 'click', 'US', '2026-06-16T10:04:20Z'),
      ev('A', 'organic-search', false, '/pricing', 'pageview', 'US', '2026-06-16T10:04:10Z'),
   ]);
});

describe('GET /api/live-view', () => {
   it('counts distinct human visitors and excludes the bot session', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.activeVisitors).toBe(3); // A, B, C (D is a bot)
      expect(res.payload.pageviewsInWindow).toBe(3); // A, B, C pageviews; A's click is not a pageview
      expect(res.payload.eventsInWindow).toBe(4); // 4 human events total
      expect(res.payload.botEventsExcluded).toBe(1);
   });

   it('defaults the window to 5 minutes and reports it', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.payload.windowMinutes).toBe(5);
   });

   it('breaks active pages down by pageview count', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const pages: any[] = res.payload.activePages;
      expect(pages.find((p) => p.key === '/pricing').count).toBe(2); // A + B pageviews
      expect(pages.find((p) => p.key === '/').count).toBe(1); // C
   });

   it('breaks sources down by normalized channel (human only)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const sources: any[] = res.payload.sources;
      // A has two human events both organic-search, B ai, C direct. The bot D is excluded.
      expect(sources.find((s) => s.key === 'organic-search').count).toBe(2);
      expect(sources.find((s) => s.key === 'ai').count).toBe(1);
      expect(sources.find((s) => s.key === 'direct').count).toBe(1);
   });

   it('returns recent events newest-first, human-only, capped', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const recent: any[] = res.payload.recentEvents;
      expect(recent.length).toBe(4); // 4 human events
      expect(recent[0].created).toBe('2026-06-16T10:04:40Z'); // C, the newest human row
      expect(recent.every((e) => e.source !== undefined)).toBe(true);
   });

   it('clamps an oversized window to the max', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', windowMinutes: '9999' }), res);
      expect(res.payload.windowMinutes).toBe(60);
   });

   it('400s when the domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });

   it('403s when the domain is not owned by the account', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'notmine.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      const req = { method: 'POST', query: { domain: 'getmasset.com' }, body: {}, headers: {} } as unknown as NextApiRequest;
      await handler(req, res);
      expect(res.statusCode).toBe(405);
   });
});
