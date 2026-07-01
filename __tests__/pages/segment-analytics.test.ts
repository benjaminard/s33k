/**
 * segment-analytics route: a human-analytics-style traffic summary for a SAVED segment, applied by
 * name. Mocks the models; the real sessionize + stored-filter parsing logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/segment', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/segment-analytics';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import SegmentModel from '../../database/models/segment';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockSegment = SegmentModel as unknown as { findOne: jest.Mock };
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
   // Default segment: AI traffic, human-only.
   mockSegment.findOne.mockResolvedValue(row({ ID: 1, name: 'AI human', filters: '{"channel":"ai","humanOnly":true}' }));
   // A: ai human, 2 pageviews (engaged). B: ai human, 1 pageview (bounce). C: organic human (filtered out).
   // D: ai BOT (filtered out by humanOnly).
   mockEvent.findAll.mockResolvedValue([
      pv('A', 'ai', false, '/', '2026-06-16T10:00:00Z'),
      pv('A', 'ai', false, '/pricing', '2026-06-16T10:01:00Z'),
      pv('B', 'ai', false, '/', '2026-06-16T10:02:00Z'),
      pv('C', 'organic-search', false, '/', '2026-06-16T10:03:00Z'),
      pv('D', 'ai', true, '/', '2026-06-16T10:04:00Z'),
   ]);
});

describe('GET /api/segment-analytics', () => {
   it('applies the saved segment filters by name and returns a human-analytics-style summary', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', segment: 'AI human' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.segment.name).toBe('AI human');
      // Only A and B match (ai + human). C is organic, D is a bot.
      expect(res.payload.summary.visitors).toBe(2);
      expect(res.payload.summary.pageviews).toBe(3);
      // A is engaged (2 pv), B is a bounce (1 pv) -> 50% bounce.
      expect(res.payload.summary.bounceRatePct).toBe(50);
      expect(res.payload.filters.channel).toBe('ai');
      expect(res.payload.filters.humanOnly).toBe(true);
   });

   it('resolves a segment by segmentId as well as name', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', segmentId: '1' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.segment.id).toBe(1);
   });

   it('400s when neither segment nor segmentId is given', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(400);
   });

   it('404s when the segment does not exist', async () => {
      mockSegment.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', segment: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('403s when the domain is not owned', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com', segment: 'AI human' }), res);
      expect(res.statusCode).toBe(403);
   });
});
