/**
 * Registration canonicalization tests for pages/api/domains.ts addDomain (cross-tenant-leak fix).
 *
 * The third-adversarial-review bug: Domain rows were stored UN-normalized (just trimmed), so two
 * canonical-equal names ("getmasset.com" and "getmasset.com." / "WWW.getmasset.com") could coexist
 * as separate @Unique rows under DIFFERENT owners, and a scoped share key for one could then resolve
 * the sibling. The fix canonicalizes at write time and rejects a canonical-colliding duplicate. This
 * suite drives the REAL addDomain handler (only the DB models + authorize mocked) and proves:
 *   a. registering a canonical-colliding variant of an existing domain is REJECTED as a duplicate,
 *      with NO bulkCreate (no second row);
 *   b. a fresh domain is stored in its CANONICAL bare-host form (lowercase, no scheme/www/trailing dot);
 *   c. an in-request duplicate (same canonical twice) is deduped to one stored row.
 *
 * No network, no DB: database/database is a no-op, the Domain/Keyword models + authorize are mocked.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findAll: jest.fn(), bulkCreate: jest.fn(), count: jest.fn() },
}));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn(), destroy: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/domains', () => ({ __esModule: true, default: jest.fn(async (d: unknown) => d) }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   checkSerchConsoleIntegration: jest.fn(async () => ({ isValid: true })),
   removeLocalSCData: jest.fn(async () => true),
}));
jest.mock('../../utils/scraper', () => ({ __esModule: true, removeFromRetryQueue: jest.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import domainsHandler from '../../pages/api/domains';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock, bulkCreate: jest.Mock, count: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (body: unknown): NextApiRequest => ({
   method: 'POST', url: '/api/domains', query: {}, headers: {}, body,
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, any> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   asCaller(ADMIN);
   mockDomain.findAll.mockResolvedValue([]);
   // The new billing site-cap calls Domain.count. As ADMIN (MULTI_TENANT off) caps are unlimited, so
   // the count value is irrelevant to these canonicalization tests; it just must be a resolvable number.
   mockDomain.count.mockResolvedValue(0);
   mockDomain.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((r) => ({ get: () => r, ...r })));
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('addDomain rejects a canonical-colliding duplicate (a)', () => {
   it.each(['getmasset.com.', 'WWW.getmasset.com', 'GETMASSET.com', 'https://getmasset.com/'])(
      'rejects %s when getmasset.com already exists, without bulkCreate',
      async (variant) => {
         // The existence check queries canonical names; the canonical of every variant is getmasset.com,
         // which already exists, so the route must 400 and never insert a second row.
         mockDomain.findAll.mockResolvedValue([{ domain: 'getmasset.com' }]);
         const res = makeRes();
         await domainsHandler(makeReq({ domains: [variant] }), res);
         expect(res.statusCode).toBe(400);
         expect(res.payload.error).toMatch(/already exists/i);
         expect(mockDomain.bulkCreate).not.toHaveBeenCalled();
         // The duplicate check is on the CANONICAL form.
         expect(mockDomain.findAll.mock.calls[0][0].where.domain).toEqual({ [require('sequelize').Op.in]: ['getmasset.com'] });
      },
   );
});

describe('addDomain stores the canonical bare host (b)', () => {
   it('stores lowercase, scheme/www/trailing-dot stripped', async () => {
      const res = makeRes();
      await domainsHandler(makeReq({ domains: ['HTTPS://WWW.GetMasset.com.'] }), res);
      expect(res.statusCode).toBe(201);
      expect(mockDomain.bulkCreate.mock.calls[0][0][0].domain).toBe('getmasset.com');
      // The slug is derived from the canonical domain.
      expect(mockDomain.bulkCreate.mock.calls[0][0][0].slug).toBe('getmasset-com');
   });

   it('400s when a submitted domain canonicalizes to empty', async () => {
      const res = makeRes();
      await domainsHandler(makeReq({ domains: ['https://'] }), res);
      expect(res.statusCode).toBe(400);
      expect(mockDomain.bulkCreate).not.toHaveBeenCalled();
   });
});

describe('addDomain dedupes an in-request canonical collision (c)', () => {
   it('stores ONE row when the same canonical domain is submitted twice', async () => {
      const res = makeRes();
      await domainsHandler(makeReq({ domains: ['getmasset.com', 'WWW.getmasset.com'] }), res);
      expect(res.statusCode).toBe(201);
      const created = mockDomain.bulkCreate.mock.calls[0][0] as any[];
      expect(created.length).toBe(1);
      expect(created[0].domain).toBe('getmasset.com');
   });
});
