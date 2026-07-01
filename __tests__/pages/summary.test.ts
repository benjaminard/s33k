/**
 * summary route (/api/summary): returns the RAW provider visitor total (bot-inclusive) AND the
 * canonical first-party HUMAN count (datacenter-filtered) side by side, so the bare "visitors"
 * number can never be mistaken for the real human number that start_here / dashboard / human_traffic
 * report. Verifies both fields are returned and that the divergence note fires past the 25% gap.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/analytics', () => ({ __esModule: true, getAnalyticsProvider: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/summary';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockProvider = getAnalyticsProvider as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const pv = (session: string, page: string, is_bot: boolean, created: string) =>
   row({ session, page, is_bot, created, type: 'pageview', source: 'direct', device: 'desktop', country: 'US' });

const makeReq = (query: Record<string, string>): NextApiRequest => ({
   method: 'GET', query, body: {}, headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

const summaryResult = (visitors: number) => ({
   pageviews: visitors * 2, visitors, visits: visitors, bounceRate: 50, avgDuration: 30, pagesPerVisit: 2, error: null,
});

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
});

describe('GET /api/summary', () => {
   it('returns both visitorsRaw (bot-inclusive) and humanVisitors (datacenter-filtered)', async () => {
      // Provider reports a bot-inflated raw total of 4. First-party rows: 2 human sessions, 1 bot.
      mockProvider.mockReturnValue({ getSummary: jest.fn(async () => summaryResult(4)) });
      mockEvent.findAll.mockResolvedValue([
         pv('A', '/', false, '2026-06-16T10:00:00.000Z'),
         pv('B', '/', false, '2026-06-16T10:02:00.000Z'),
         pv('C', '/', true, '2026-06-16T10:03:00.000Z'),
      ]);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.visitorsRaw).toBe(4); // raw provider total, includes bots
      expect(res.payload.humanVisitors).toBe(2); // sessions A + B, bot C filtered
      expect(res.payload.summary.visitors).toBe(4); // back-compat field unchanged
   });

   it('fires the divergence note when raw and human diverge by more than 25%', async () => {
      // Raw 724 vs human 177 (the real getmasset gap): ~76% divergence, well past 25%.
      mockProvider.mockReturnValue({ getSummary: jest.fn(async () => summaryResult(724)) });
      const rows = [] as ReturnType<typeof pv>[];
      for (let i = 0; i < 177; i += 1) { rows.push(pv(`h${i}`, '/', false, `2026-06-16T10:00:${String(i % 60).padStart(2, '0')}.000Z`)); }
      mockEvent.findAll.mockResolvedValue(rows);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.payload.humanVisitors).toBe(177);
      expect(res.payload.note).toBe(
         'Raw provider total counts differently and includes bots; humanVisitors is the datacenter-filtered first-party number to trust.',
      );
   });

   it('omits the note when raw and human are within 25%', async () => {
      // Raw 10 vs human 9: 10% divergence, under the threshold, so no note.
      mockProvider.mockReturnValue({ getSummary: jest.fn(async () => summaryResult(10)) });
      const rows = [] as ReturnType<typeof pv>[];
      for (let i = 0; i < 9; i += 1) {
         rows.push(pv(`h${i}`, '/', false, `2026-06-16T10:00:0${i}.000Z`));
      }
      mockEvent.findAll.mockResolvedValue(rows);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.payload.humanVisitors).toBe(9);
      expect(res.payload.note).toBeUndefined();
   });

   it('403s when the domain is not owned', async () => {
      mockProvider.mockReturnValue({ getSummary: jest.fn(async () => summaryResult(1)) });
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });
});
