/**
 * funnel route: ordered multi-step funnel with per-step drop-off, human-only default, and step
 * parsing/validation. Mocks the models and authorize; the real sessionize + funnel math runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/funnel';
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
const pv = (session: string, is_bot: boolean, page: string, created: string) =>
   row({ session, source: 'direct', is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created });
const ev = (session: string, is_bot: boolean, type: string, page: string, created: string) =>
   row({ session, source: 'direct', is_bot, device: 'desktop', country: 'US', page, type, created });

const makeReq = (query: Record<string, string>): NextApiRequest => ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

// Three steps: viewed /pricing -> viewed /cart -> fired checkout event.
const STEPS = JSON.stringify([
   { type: 'page', match: '/pricing' },
   { type: 'page', match: '/cart' },
   { type: 'event', match: 'checkout' },
]);

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   // A: all 3 steps (full funnel). B: pricing + cart, no checkout. C: pricing only. D: bot, all 3.
   // E: human, never hit pricing (lands deeper) so step 1 already excludes it.
   mockEvent.findAll.mockResolvedValue([
      pv('A', false, '/pricing', '2026-06-16T10:00:00Z'),
      pv('A', false, '/cart', '2026-06-16T10:01:00Z'),
      ev('A', false, 'checkout', '/cart', '2026-06-16T10:02:00Z'),
      pv('B', false, '/pricing', '2026-06-16T10:03:00Z'),
      pv('B', false, '/cart', '2026-06-16T10:04:00Z'),
      pv('C', false, '/pricing', '2026-06-16T10:05:00Z'),
      pv('D', true, '/pricing', '2026-06-16T10:06:00Z'),
      pv('D', true, '/cart', '2026-06-16T10:07:00Z'),
      ev('D', true, 'checkout', '/cart', '2026-06-16T10:08:00Z'),
      pv('E', false, '/about', '2026-06-16T10:09:00Z'),
   ]);
});

describe('GET /api/funnel', () => {
   it('computes ordered per-step reached + drop-off, human-only', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', steps: STEPS }), res);
      expect(res.statusCode).toBe(200);
      // 4 human sessions (A, B, C, E); D is a bot, excluded.
      expect(res.payload.funnel.totalSessions).toBe(4);
      expect(res.payload.botSessionsExcluded).toBe(1);
      const steps = res.payload.funnel.steps;
      // Step 1 (viewed /pricing): A, B, C reached; E did not. 3 of 4.
      expect(steps[0].reached).toBe(3);
      expect(steps[0].conversionFromPreviousPct).toBe(75);
      expect(steps[0].dropOffPct).toBe(25);
      // Step 2 (viewed /cart): A, B reached. 2 of 3 from prev step.
      expect(steps[1].reached).toBe(2);
      expect(steps[1].conversionFromPreviousPct).toBe(66.7);
      expect(steps[1].dropOffPct).toBe(33.3);
      // Step 3 (checkout event): only A. 1 of 2 from prev step.
      expect(steps[2].reached).toBe(1);
      expect(steps[2].conversionFromPreviousPct).toBe(50);
      expect(steps[2].dropOffPct).toBe(50);
   });

   it('enforces ORDER: a later step is not credited when an earlier one was skipped', async () => {
      // F viewed /cart and checked out but NEVER viewed /pricing: must not count for step 2 or 3.
      mockEvent.findAll.mockResolvedValue([
         pv('F', false, '/cart', '2026-06-16T11:00:00Z'),
         ev('F', false, 'checkout', '/cart', '2026-06-16T11:01:00Z'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', steps: STEPS }), res);
      const steps = res.payload.funnel.steps;
      expect(res.payload.funnel.totalSessions).toBe(1);
      expect(steps[0].reached).toBe(0); // never viewed /pricing
      expect(steps[1].reached).toBe(0); // not credited despite viewing /cart
      expect(steps[2].reached).toBe(0); // not credited despite checkout
   });

   it('includeBots folds the bot session back into the funnel', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', steps: STEPS, includeBots: 'true' }), res);
      expect(res.payload.funnel.totalSessions).toBe(5); // A, B, C, D, E
      expect(res.payload.botSessionsExcluded).toBe(0);
      // Step 3 now A + D both completed checkout.
      expect(res.payload.funnel.steps[2].reached).toBe(2);
   });

   it('400s when steps is missing', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(400);
      expect(String(res.payload.error)).toMatch(/steps is required/i);
   });

   it('400s when steps is not valid JSON', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', steps: 'not-json' }), res);
      expect(res.statusCode).toBe(400);
      expect(String(res.payload.error)).toMatch(/valid JSON array/i);
   });

   it('400s when a step has a bad type', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', steps: JSON.stringify([{ type: 'nope', match: '/x' }]) }), res);
      expect(res.statusCode).toBe(400);
      expect(String(res.payload.error)).toMatch(/type must be/i);
   });

   it('403s when the domain is not owned by the account', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', steps: STEPS }), res);
      expect(res.statusCode).toBe(403);
   });
});
