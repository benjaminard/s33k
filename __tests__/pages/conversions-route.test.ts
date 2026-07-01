/**
 * Behavioral tests for the conversions-by-source READ route
 * (pages/api/conversions.ts), the read half of conversion attribution.
 *
 * Single-user: there is one account (the admin sentinel). scopeWhere is always {}, so reads
 * carry no owner_id. The route still gates on the domain existing (Domain.findOne null -> the
 * domain is not registered), which this suite exercises indirectly through the happy path.
 *
 * Contracts under test:
 *   1. Groups conversions by source and reports counts, share, top source, and an honest
 *      approximate conversion-rate note when a session base exists.
 *   2. event defaults to 'form_submit' but any captured event type can be attributed.
 *   3. Degrades on an empty event set: 200 with zero conversions, null top source, and no rate
 *      note. Never 500s on a sub-signal failure.
 *   4. Missing domain -> 400, nothing read. Non-GET -> 405.
 *
 * Models are mocked, authorize is mocked per-test. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// The route imports { Op } from 'sequelize'. Stub it so jest never transforms sequelize's ESM
// deps; the models are mocked, so Op is only a unique object key in the findAll where.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import conversionsHandler from '../../pages/api/conversions';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (query: Record<string, string> = {}, method = 'GET'): NextApiRequest => ({
   method,
   query,
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

// A minimal raw event row as findAll({ raw: true }) returns it.
const row = (over: Partial<{ type: string, source: string, session: string }>) => ({
   type: 'form_submit', page: '/signup', label: 'signup', selector: null, value: null,
   session: 's1', source: 'direct', created: new Date().toJSON(), ...over,
});

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/conversions: attribution shape', () => {
   it('groups conversions by source with counts, share, top source, and an approximate rate note', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      // 3 ai conversions (across 2 sessions) + 1 direct conversion (1 session).
      mockEvent.findAll.mockResolvedValue([
         row({ type: 'form_submit', source: 'ai', session: 's1' }),
         row({ type: 'form_submit', source: 'ai', session: 's1' }),
         row({ type: 'form_submit', source: 'ai', session: 's2' }),
         row({ type: 'form_submit', source: 'direct', session: 's3' }),
      ]);
      const res = makeRes();

      await conversionsHandler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      const body = res.payload as Record<string, unknown>;
      expect(body.event).toBe('form_submit');
      expect(body.totalConversions).toBe(4);
      expect(body.topSource).toEqual({ source: 'ai', count: 3 });
      const conversions = body.conversions as Array<{ source: string, count: number, share: number, conversionRate: number | null }>;
      const ai = conversions.find((c) => c.source === 'ai');
      expect(ai?.count).toBe(3);
      expect(ai?.share).toBe(75); // 3 of 4
      // rate = conversions / distinct event-bearing sessions for that source = 3 / 2 sessions.
      expect(ai?.conversionRate).toBe(150);
      expect(body.conversionRateNote).toMatch(/[Aa]pproximate/);
   });

   it('attributes a non-default event type when ?event= is passed', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockEvent.findAll.mockResolvedValue([
         row({ type: 'outbound', source: 'referral', session: 's1' }),
         row({ type: 'form_submit', source: 'ai', session: 's2' }), // ignored: not the chosen type
      ]);
      const res = makeRes();

      await conversionsHandler(makeReq({ domain: 'a.com', event: 'outbound' }), res);

      expect(res.statusCode).toBe(200);
      const body = res.payload as Record<string, unknown>;
      expect(body.event).toBe('outbound');
      expect(body.totalConversions).toBe(1);
      expect(body.topSource).toEqual({ source: 'referral', count: 1 });
   });
});

describe('GET /api/conversions: degrade + guard rails', () => {
   it('degrades on an empty event set: 200, zero conversions, null top source, no rate note', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockEvent.findAll.mockResolvedValue([]);
      const res = makeRes();

      await conversionsHandler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      const body = res.payload as Record<string, unknown>;
      expect(body.totalConversions).toBe(0);
      expect(body.conversions).toEqual([]);
      expect(body.topSource).toBeNull();
      expect(body.conversionRateNote).toBeNull();
      expect(body.error).toBeNull();
   });

   it('400s when domain is missing and never reads events', async () => {
      asCaller(ADMIN);
      const res = makeRes();

      await conversionsHandler(makeReq({}), res);

      expect(res.statusCode).toBe(400);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.findAll).not.toHaveBeenCalled();
   });

   it('405s a non-GET method', async () => {
      asCaller(ADMIN);
      const res = makeRes();

      await conversionsHandler(makeReq({}, 'POST'), res);

      expect(res.statusCode).toBe(405);
   });
});
