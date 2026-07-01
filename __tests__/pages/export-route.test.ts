/**
 * Tests for the DATA EXPORT route (pages/api/export.ts).
 *
 * Single-user: there is one account (the admin sentinel). scopeWhere is always {}, so the export
 * returns all of the user's own data with no owner scoping.
 *
 * Contracts under test:
 *   1. Exports the user's domains, keywords (restricted to the owned domain set), and events.
 *   2. NO SECRETS EVER LEAVE. The encrypted Search Console blob on a domain is stripped to
 *      a boolean (search_console_configured); its value is never present in the response.
 *   3. The bundle is shaped as advertised (counts match, accountId echoed).
 *   4. Method + auth gating: unauthorized -> 401 (nothing read); non-GET -> 405.
 *
 * The DB layer is mocked to a no-op sync, every model is mocked, sequelize Op is stubbed (the
 * route imports it directly), and authorize is mocked per-test to inject the caller. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// export.ts imports { Op } from 'sequelize'. Stub it so jest never transforms sequelize's
// ESM deps; the models are mocked, so Op.in is only a stable unique key in the where-clauses.
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import { Op } from 'sequelize';
// eslint-disable-next-line import/first
import exportHandler from '../../pages/api/export';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

// A plain stand-in for a sequelize row: get({plain}) returns a flat object.
const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (opts: { method?: string } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   // Sensible defaults so every query returns empty unless a test overrides it.
   mockDomain.findAll.mockResolvedValue([]);
   mockKeyword.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/export shape', () => {
   it('returns the user\'s domains, keywords, and events, restricting keyword/event reads to the owned domain set', async () => {
      asCaller(ADMIN);
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'a.com', owner_id: null, search_console: null })]);
      mockKeyword.findAll.mockResolvedValue([row({ ID: 11, keyword: 'seo', domain: 'a.com' })]);
      mockEvent.findAll.mockResolvedValue([row({ ID: 31, domain: 'a.com', name: 'pageview' })]);

      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect(res.statusCode).toBe(200);

      // Keyword + event reads are restricted to the domain-IN filter of the owned domains.
      expect(mockKeyword.findAll.mock.calls[0][0].where.domain[Op.in]).toEqual(['a.com']);
      expect(mockEvent.findAll.mock.calls[0][0].where.domain[Op.in]).toEqual(['a.com']);

      const payload = res.payload as Record<string, any>;
      expect(payload.accountId).toBe(ADMIN_ACCOUNT_ID);
      expect(payload.domains.map((d: any) => d.domain)).toEqual(['a.com']);
      expect(payload.counts).toMatchObject({ domains: 1, keywords: 1, events: 1 });
   });

   it('scopes keyword and event reads to an EMPTY domain set when there are no domains', async () => {
      asCaller(ADMIN);
      mockDomain.findAll.mockResolvedValue([]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect(mockKeyword.findAll.mock.calls[0][0].where.domain[Op.in]).toEqual([]);
      expect(mockEvent.findAll.mock.calls[0][0].where.domain[Op.in]).toEqual([]);
   });
});

describe('GET /api/export never emits a secret', () => {
   it('strips the encrypted search_console blob to a boolean and never includes its value', async () => {
      asCaller(ADMIN);
      const encryptedBlob = JSON.stringify({ client_email: 'svc@x.com', private_key: 'PRIVATE_KEY_VALUE' });
      mockDomain.findAll.mockResolvedValue([
         row({ ID: 1, domain: 'a.com', owner_id: null, search_console: encryptedBlob }),
      ]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      const domain = (res.payload as Record<string, any>).domains[0];
      expect(domain.search_console).toBeUndefined();
      expect(domain.search_console_configured).toBe(true);
      // The encrypted/secret value must not appear anywhere in the serialized response.
      expect(JSON.stringify(res.payload)).not.toContain('PRIVATE_KEY_VALUE');
   });

   it('reports search_console_configured=false when no credentials are present', async () => {
      asCaller(ADMIN);
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'a.com', owner_id: null, search_console: null })]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect((res.payload as Record<string, any>).domains[0].search_console_configured).toBe(false);
   });
});

describe('GET /api/export method + auth gating', () => {
   it('401s an unauthorized caller and never reads any data', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: undefined, error: 'nope' });
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect(res.statusCode).toBe(401);
      expect(mockDomain.findAll).not.toHaveBeenCalled();
   });

   it('405s a non-GET method', async () => {
      asCaller(ADMIN);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'POST' }), res);

      expect(res.statusCode).toBe(405);
      expect(mockDomain.findAll).not.toHaveBeenCalled();
   });
});
