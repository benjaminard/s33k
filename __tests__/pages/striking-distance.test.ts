/**
 * striking-distance route: near-miss "quick win" keywords ranking just off page one (positions 4 to
 * 30), each annotated with its position delta over history. Mocks the models; the real
 * findStrikingDistance logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/striking-distance';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const kw = (keyword: string, position: number, url: string, history: Record<string, number>) =>
   row({ keyword, position, url: JSON.stringify([url]), history: JSON.stringify(history) });

const makeReq = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
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
   mockKeyword.findAll.mockResolvedValue([
      // In window, improving (18 -> 12, delta -6).
      kw('ai-ready dam', 12, 'https://getmasset.com/dam', { '2026-06-01': 18, '2026-06-10': 15, '2026-06-16': 12 }),
      // In window, closest to page one (position 5), slipping (4 -> 5, delta +1).
      kw('dam mcp server', 5, 'https://getmasset.com/mcp', { '2026-06-01': 4, '2026-06-16': 5 }),
      // In window, no history -> null delta.
      kw('highspot alternative', 22, 'https://getmasset.com/highspot', {}),
      // Already page one (position 1) -> excluded.
      kw('masset', 1, 'https://getmasset.com/', { '2026-06-01': 1 }),
      // Outside top 100 (position 0) -> excluded.
      kw('how to make website ai readable', 0, 'https://getmasset.com/ai', {}),
      // Beyond max (position 38) -> excluded by default window.
      kw('seismic alternative', 38, 'https://getmasset.com/seismic', { '2026-06-01': 40 }),
   ]);
});

describe('GET /api/striking-distance', () => {
   it('returns only keywords inside the default 4 to 30 window, sorted by closeness to page one', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.total).toBe(3);
      const positions = res.payload.keywords.map((k: any) => k.position);
      expect(positions).toEqual([5, 12, 22]); // ascending position = closeness to page one
      const terms = res.payload.keywords.map((k: any) => k.keyword);
      expect(terms).toEqual(['dam mcp server', 'ai-ready dam', 'highspot alternative']);
   });

   it('computes position delta from history (negative = improving) and the ranking url', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const byTerm = (t: string) => res.payload.keywords.find((k: any) => k.keyword === t);
      expect(byTerm('ai-ready dam').positionDelta).toBe(-6); // 18 -> 12
      expect(byTerm('ai-ready dam').url).toBe('https://getmasset.com/dam');
      expect(byTerm('dam mcp server').positionDelta).toBe(1); // 4 -> 5 (slipping)
      expect(byTerm('highspot alternative').positionDelta).toBeNull(); // no history
   });

   it('respects a custom min/max window', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', min: '4', max: '13' }), res);
      const positions = res.payload.keywords.map((k: any) => k.position);
      expect(positions).toEqual([5, 12]); // 22 now falls outside max=13
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });
});
