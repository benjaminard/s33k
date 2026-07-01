import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral tests for the PUBLIC ingest route (pages/api/collect.ts).
 *
 * Contracts under test:
 *   1. PUBLIC: no API key needed. A known domain with a clean batch stores rows and 200s.
 *   2. owner_id is stamped from the owning Domain so reads are tenant-scoped.
 *   3. Unknown domain -> 403, nothing stored (not an open sink).
 *   4. Missing domain -> 400.
 *   5. Bot user-agent -> 200 with 0 recorded, nothing stored.
 *   6. PII-shaped events are dropped (never stored); clean events in the same batch are kept.
 *   7. Skip-and-continue: a row that fails to create does NOT 500 the batch; the rest store.
 *   8. Non-POST (GET) -> 405.
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
import { __resetRateLimit } from '../../utils/collect-guards';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { create: jest.Mock };

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
   + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const makeReq = (opts: { method?: string, body?: unknown, ua?: string, ip?: string } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body ?? {},
   query: {},
   headers: { 'user-agent': opts.ua ?? BROWSER_UA, 'x-forwarded-for': opts.ip ?? '203.0.113.7' },
   socket: { remoteAddress: '203.0.113.7' },
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

describe('POST /api/collect: happy path', () => {
   it('stores a clean batch for a known domain and stamps owner_id', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: { domain: 'acme.io', session: 'sid1', events: [
         { type: 'click', page: '/pricing', label: 'Buy', selector: 'a.cta' },
         { type: 'scroll', page: '/pricing', value: 80 },
      ] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(2);
      expect(mockEvent.create).toHaveBeenCalledTimes(2);
      // owner_id stamped from the Domain so the rows are tenant-scoped for reads.
      expect(mockEvent.create.mock.calls[0][0].owner_id).toBe(7);
      expect(mockEvent.create.mock.calls[0][0].domain).toBe('acme.io');
   });

   it('passes null owner_id through for a legacy (admin) domain', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'legacy.io', owner_id: null });
      const req = makeReq({ body: { domain: 'legacy.io', events: [{ type: 'click', page: '/', label: 'x' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockEvent.create.mock.calls[0][0].owner_id).toBeNull();
   });
});

describe('POST /api/collect: rejection paths', () => {
   it('403s an unknown domain and stores nothing', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const req = makeReq({ body: { domain: 'stranger.com', events: [{ type: 'click', page: '/', label: 'x' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockEvent.create).not.toHaveBeenCalled();
   });

   it('400s a missing domain', async () => {
      const req = makeReq({ body: { events: [{ type: 'click', page: '/', label: 'x' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(mockEvent.create).not.toHaveBeenCalled();
   });

   it('drops bot traffic: 0 recorded, domain never even looked up', async () => {
      const req = makeReq({ ua: 'GPTBot/1.0', body: { domain: 'acme.io', events: [{ type: 'click', page: '/', label: 'x' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(0);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.create).not.toHaveBeenCalled();
   });

   it('405s a GET', async () => {
      const req = makeReq({ method: 'GET' });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(405);
      expect(mockEvent.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/collect: source attribution (privacy-safe)', () => {
   it('stamps a classified session source on every stored event', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: { domain: 'acme.io', source: 'ai', events: [
         { type: 'form_submit', page: '/signup', label: 'signup' },
         { type: 'click', page: '/signup', label: 'Go' },
      ] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockEvent.create.mock.calls[0][0].source).toBe('ai');
      expect(mockEvent.create.mock.calls[1][0].source).toBe('ai');
   });

   it('downgrades a URL-like source to direct (never stores a full referrer URL)', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: { domain: 'acme.io', source: 'https://x.com/p?email=a@b.com', events: [
         { type: 'click', page: '/', label: 'Go' },
      ] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockEvent.create.mock.calls[0][0].source).toBe('direct');
   });

   it('defaults a missing source to direct', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: { domain: 'acme.io', events: [{ type: 'click', page: '/', label: 'Go' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockEvent.create.mock.calls[0][0].source).toBe('direct');
   });
});

describe('POST /api/collect: PII defense + resilience', () => {
   it('drops PII events but stores the clean ones in the same batch', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: { domain: 'acme.io', events: [
         { type: 'form_submit', page: '/signup', label: 'jane@example.com' }, // PII -> dropped
         { type: 'click', page: '/signup', label: 'Create account', selector: 'button' }, // kept
      ] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(1);
      expect(mockEvent.create).toHaveBeenCalledTimes(1);
      expect(mockEvent.create.mock.calls[0][0].label).toBe('Create account');
   });

   it('skip-and-continue: a failing row does not 500 the batch', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      mockEvent.create
         .mockRejectedValueOnce(new Error('db blip'))
         .mockResolvedValueOnce({ ID: 2 });
      const req = makeReq({ body: { domain: 'acme.io', events: [
         { type: 'click', page: '/', label: 'a' },
         { type: 'click', page: '/', label: 'b' },
      ] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(1);
      expect(mockEvent.create).toHaveBeenCalledTimes(2);
   });
});
