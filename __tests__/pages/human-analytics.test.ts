/**
 * human-analytics route: human-only traffic computed from first-party pageview rows.
 * Verifies bot exclusion (is_bot), bounce rate (single-pageview sessions), entry/exit pages,
 * and exit-rate math (exits-on-page / pageviews-of-page).
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/human-analytics';
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

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
});

describe('GET /api/human-analytics', () => {
   it('excludes bots and computes bounce, entry, and exit rate from human pageviews', async () => {
      // Session A: / then /pricing (human, 2 views, not a bounce).
      // Session B: / only (human, bounce).
      // Session C: / only (BOT, must be excluded from human-only numbers).
      mockEvent.findAll.mockResolvedValue([
         pv('A', '/', false, '2026-06-16T10:00:00.000Z'),
         pv('A', '/pricing', false, '2026-06-16T10:01:00.000Z'),
         pv('B', '/', false, '2026-06-16T10:02:00.000Z'),
         pv('C', '/', true, '2026-06-16T10:03:00.000Z'),
      ]);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);

      expect(res.statusCode).toBe(200);
      const s = res.payload.summary;
      expect(s.visitors).toBe(2); // human sessions A + B
      expect(s.pageviews).toBe(3); // human pageviews only
      expect(s.bounceRatePct).toBe(50); // B bounced of {A,B}
      expect(s.botVisitorsFiltered).toBe(1); // session C
      expect(s.botSharePct).toBe(33.3); // 1 of 3 visitors

      // Entry pages: both A and B entered on '/'.
      expect(res.payload.entryPages.find((e: any) => e.page === '/').entries).toBe(2);

      // Exit pages + exit rate: /pricing has 1 exit of 1 pageview (100%); '/' has 1 exit of 2 (50%).
      const exits: any[] = res.payload.exitPages;
      expect(exits.find((e: any) => e.page === '/pricing').exitRatePct).toBe(100);
      expect(exits.find((e: any) => e.page === '/').exitRatePct).toBe(50);
   });

   it('includeBots=true folds bots back into the numbers', async () => {
      mockEvent.findAll.mockResolvedValue([
         pv('A', '/', false, '2026-06-16T10:00:00.000Z'),
         pv('C', '/', true, '2026-06-16T10:03:00.000Z'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', includeBots: 'true' }), res);
      expect(res.payload.summary.visitors).toBe(2); // both A and C counted
      expect(res.payload.includesBots).toBe(true);
   });

   it('403s when the domain is not owned', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });
});
