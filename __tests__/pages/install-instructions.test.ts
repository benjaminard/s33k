/**
 * Response-shape test for the on-demand install-instructions route (pages/api/install-instructions.ts).
 *
 * The route returns the s33k.js beacon snippet + per-platform install guides for an already-onboarded,
 * caller-owned domain. The first-party beacon keys every event by domain, so the site id IS the
 * domain. This test pins the user-facing response SHAPE: the site id is surfaced under the
 * `siteId` key (equal to the domain), and no internal provider name leaks.
 *
 * Every side-effecting dependency is mocked (DB sync, authorize, domain-access). install-guides runs
 * for real (pure product knowledge) so the returned snippet shape is genuinely exercised. No network.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// The route imports the sequelize-typescript Domain model transitively; mock it away so jest never
// has to transform the decorator syntax (same pattern as install-guides.test.ts). The route never
// touches the model directly (it reads the mocked owned row).
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/domain-access', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import installInstructionsHandler from '../../pages/api/install-instructions';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import resolveDomainAccessFn from '../../utils/domain-access';

const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockResolveDomainAccess = resolveDomainAccessFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const makeReq = (opts: { method?: string, query?: Record<string, unknown> } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: {},
   query: opts.query || {},
   headers: {},
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
   process.env.S33K_BEACON_HOST = 'https://analytics.example.com';
   mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 }, error: undefined });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/install-instructions response shape', () => {
   it('surfaces the domain as the beacon `siteId` and never leaks a provider name', async () => {
      mockResolveDomainAccess.mockResolvedValue({ domain: 'getmasset.com' });

      const res = makeRes();
      await installInstructionsHandler(makeReq({ query: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload;
      expect(payload.siteId).toBe('getmasset.com');
      expect(payload).not.toHaveProperty('umamiWebsiteId');
      // The snippet embeds the domain as the site id, and no user-facing string carries a provider name.
      expect(payload.installSnippet).toContain('data-domain="getmasset.com"');
      expect(JSON.stringify(payload.installGuides)).not.toMatch(/Umami/i);
   });

   it('rejects a caller who does not own the domain with 403', async () => {
      mockResolveDomainAccess.mockResolvedValue(null);
      const res = makeRes();
      await installInstructionsHandler(makeReq({ query: { domain: 'notmine.com' } }), res);
      expect(res.statusCode).toBe(403);
   });
});
