import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Tests for UTM / campaign attribution on the PUBLIC ingest route (pages/api/collect.ts).
 *
 * Contracts under test:
 *   1. The five session-level utm_* tags are sanitized and stamped on EVERY stored event row.
 *   2. Missing UTM tags store null (untagged) and do not change any other behavior.
 *   3. A partial UTM set stores the present tags and null for the absent ones.
 *   4. UTM values are control-char stripped + whitespace collapsed + length-capped at ingest.
 *
 * Same mock setup as collect-route.test.ts: database/database is a no-op, Domain + S33kEvent are
 * jest mocks, and the rate-limit state is reset between tests. No network, no DB.
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

describe('POST /api/collect: UTM / campaign attribution', () => {
   it('stamps all five sanitized UTM tags on every stored event', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: {
         domain: 'acme.io',
         session: 'sid1',
         utm_source: 'newsletter',
         utm_medium: 'email',
         utm_campaign: 'spring_launch',
         utm_term: 'seo tool',
         utm_content: 'hero_cta',
         events: [
            { type: 'click', page: '/pricing', label: 'Buy', selector: 'a.cta' },
            { type: 'form_submit', page: '/pricing', label: 'signup' },
         ],
      } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.recorded).toBe(2);
      for (const call of mockEvent.create.mock.calls) {
         expect(call[0].utm_source).toBe('newsletter');
         expect(call[0].utm_medium).toBe('email');
         expect(call[0].utm_campaign).toBe('spring_launch');
         expect(call[0].utm_term).toBe('seo tool');
         expect(call[0].utm_content).toBe('hero_cta');
      }
   });

   it('stores null for all UTM tags when none are present (unchanged behavior)', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: { domain: 'acme.io', events: [{ type: 'click', page: '/', label: 'Go' }] } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      const row = mockEvent.create.mock.calls[0][0];
      expect(row.utm_source).toBeNull();
      expect(row.utm_medium).toBeNull();
      expect(row.utm_campaign).toBeNull();
      expect(row.utm_term).toBeNull();
      expect(row.utm_content).toBeNull();
   });

   it('keeps present tags and nulls absent ones for a partial UTM set', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: {
         domain: 'acme.io',
         utm_source: 'google',
         utm_medium: 'cpc',
         events: [{ type: 'click', page: '/', label: 'Go' }],
      } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      const row = mockEvent.create.mock.calls[0][0];
      expect(row.utm_source).toBe('google');
      expect(row.utm_medium).toBe('cpc');
      expect(row.utm_campaign).toBeNull();
      expect(row.utm_term).toBeNull();
      expect(row.utm_content).toBeNull();
   });

   it('sanitizes UTM values: strips control chars, collapses whitespace, caps length', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: {
         domain: 'acme.io',
         utm_source: '  brand\n\tname  ',
         utm_campaign: 'x'.repeat(300),
         events: [{ type: 'click', page: '/', label: 'Go' }],
      } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      const row = mockEvent.create.mock.calls[0][0];
      expect(row.utm_source).toBe('brand name');
      // Capped at MAX_UTM_LEN (150).
      expect(row.utm_campaign).toHaveLength(150);
   });

   it('ignores a non-string UTM value (stores null, never throws)', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'acme.io', owner_id: 7 });
      const req = makeReq({ body: {
         domain: 'acme.io',
         utm_source: { evil: true },
         utm_medium: 42,
         events: [{ type: 'click', page: '/', label: 'Go' }],
      } });
      const res = makeRes();

      await collectHandler(req, res);

      expect(res.statusCode).toBe(200);
      const row = mockEvent.create.mock.calls[0][0];
      expect(row.utm_source).toBeNull();
      expect(row.utm_medium).toBeNull();
   });
});
