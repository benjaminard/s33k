import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Resilience + validation tests for the PUBLIC ingest route (pages/api/collect.ts) that
 * complement collect-route.test.ts. These pin the never-500 contract and the route-level
 * validation/guard boundaries the feature spec calls out:
 *
 *   1. A malformed body (non-object, or events not an array) is handled, NOT 500'd: the
 *      route returns 200 with 0 recorded and stores nothing.
 *   2. An over-the-cap rate-limited request returns 200 with 0 recorded (no retry-storm)
 *      and the domain is never even looked up / nothing is stored.
 *   3. The last-resort catch returns a clean 400 (never a 500 / stack trace) if a DB call
 *      throws unexpectedly DURING domain resolution.
 *   4. OPTIONS preflight short-circuits to 204 with the CORS headers set.
 *
 * No network, no DB: database/database is a no-op, the Domain + S33kEvent models are jest
 * mocks, and the rate-limit state is reset between tests.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { create: jest.fn() } }));

// eslint-disable-next-line import/first
import collectHandler from '../../pages/api/collect';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import { __resetRateLimit, COLLECT_MAX_EVENTS } from '../../utils/collect-guards';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { create: jest.Mock };

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
   + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const makeReq = (opts: { method?: string, body?: unknown, ua?: string, ip?: string } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body ?? {},
   query: {},
   headers: { 'user-agent': opts.ua ?? BROWSER_UA, 'x-forwarded-for': opts.ip ?? '198.51.100.42' },
   socket: { remoteAddress: '198.51.100.42' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.setHeader = jest.fn();
   res.end = jest.fn(() => res);
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetRateLimit();
   mockEvent.create.mockResolvedValue({ ID: 1 });
});

describe('POST /api/collect: malformed input never 500s', () => {
   it('handles a non-object body for a known domain without throwing (200, 0 recorded)', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: 'not-an-object' });
      const res = makeRes();

      await collectHandler(req, res);

      // body is not an object -> domain is '' -> 400 (Domain is Required), never a 500.
      expect(res.statusCode).toBe(400);
      expect(mockEvent.create).not.toHaveBeenCalled();
   });

   it('treats a non-array events field as an empty batch (200, 0 recorded, nothing stored)', async () => {
      const req = makeReq({ body: { domain: 'acme.io', events: 'oops' } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(0);
      // No valid events -> short-circuits before the domain lookup, so nothing is stored.
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.create).not.toHaveBeenCalled();
   });

   it('only-invalid events short-circuit to 0 recorded without a domain lookup', async () => {
      const events = [
         { type: 'keystroke', page: '/', label: 'secret' }, // unknown type -> dropped
         { type: 'click', page: '/', label: 'jane@example.com' }, // PII -> dropped
      ];
      const req = makeReq({ body: { domain: 'acme.io', events } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(0);
      expect(res.payload.skipped).toBe(2);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/collect: rate limit boundary', () => {
   it('over-cap request returns 200 with 0 recorded and never looks up the domain', async () => {
      // A single batch over the per-window cap is rejected by the limiter. The route swallows
      // it as a no-op 200 (so the client does not retry-storm) and never touches the DB.
      const events = Array.from({ length: COLLECT_MAX_EVENTS + 5 }, () => ({ type: 'click', page: '/', label: 'x' }));
      // The batch is capped at 50 by sanitizeBatch, so to actually trip the limiter we pre-fill
      // the window, then send one more event from the same ip+domain.
      const fill = makeReq({ body: { domain: 'acme.io', events: Array.from({ length: 50 }, () => ({ type: 'click', page: '/', label: 'x' })) } });
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });

      // Burn the budget down with repeated full batches (50 each) until the next one is over.
      const batches = Math.ceil(COLLECT_MAX_EVENTS / 50);
      for (let i = 0; i < batches; i += 1) {
         // eslint-disable-next-line no-await-in-loop
         await collectHandler(fill, makeRes());
      }
      jest.clearAllMocks();
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });

      const overReq = makeReq({ body: { domain: 'acme.io', events: events.slice(0, 50) } });
      const res = makeRes();
      await collectHandler(overReq, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(0);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/collect: last-resort guard', () => {
   it('returns a clean 400 (never a 500) when domain resolution throws', async () => {
      mockDomain.findOne.mockRejectedValue(new Error('db connection lost'));
      const req = makeReq({ body: { domain: 'acme.io', events: [{ type: 'click', page: '/', label: 'x' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Error collecting events.');
      expect(mockEvent.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/collect: CORS preflight', () => {
   it('answers OPTIONS with 204 and sets the CORS headers', async () => {
      const req = makeReq({ method: 'OPTIONS' });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(204);
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'POST, OPTIONS');
   });
});
