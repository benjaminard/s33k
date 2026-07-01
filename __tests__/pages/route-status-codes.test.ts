/**
 * A13: HTTP status-code standardization across pages/api (method-mismatch family).
 *
 * Contract under test: an UNHANDLED HTTP METHOD returns 405 Method Not Allowed, never the old,
 * wrong 502. Each route below ends its method switch with a fallthrough that previously answered
 * 502; this asserts the corrected 405. settings.ts has its own file (route-status-codes-settings
 * .test.ts) because refresh.ts imports settings' getAppSettings, which must be mocked here and so
 * cannot coexist with a real-settings-handler test in the same module.
 *
 * Auth, the DB sync, the sequelize Op symbol, models, and the heavy scraper/SC/adwords utils are
 * mocked (the repo's established route-test pattern) so these tests assert ONLY the status code.
 * The 405 fallthrough fires before any of those are touched.
 */

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/verifyUser', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: { create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), update: jest.fn() },
}));
jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), update: jest.fn() },
}));

// Heavy utils that transitively pull untranspiled ESM (cheerio via scrapers, etc). The method
// fallthrough never calls them; mocking only keeps the import graph jest-parseable.
jest.mock('../../scrapers/index', () => ({ __esModule: true, default: [] }));
jest.mock('../../utils/scraper', () => ({
   __esModule: true,
   scrapeKeywordFromGoogle: jest.fn(), removeFromRetryQueue: jest.fn(),
}));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({})) }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   checkSerchConsoleIntegration: jest.fn(), removeLocalSCData: jest.fn(), readLocalSCData: jest.fn(),
   integrateKeywordSCData: jest.fn(), fetchDomainSCData: jest.fn(), getSearchConsoleApiInfo: jest.fn(),
   hasSearchConsoleCredentials: jest.fn(),
}));
jest.mock('../../utils/adwords', () => ({
   __esModule: true, getKeywordsVolume: jest.fn(), updateKeywordsVolumeData: jest.fn(),
}));
jest.mock('../../utils/insight', () => ({
   __esModule: true, getCountryInsight: jest.fn(), getKeywordsInsight: jest.fn(), getPagesInsight: jest.fn(),
}));
jest.mock('../../utils/domains', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import verifyUserFn from '../../utils/verifyUser';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';

// eslint-disable-next-line import/first
import clearfailedHandler from '../../pages/api/clearfailed';
// eslint-disable-next-line import/first
import refreshHandler from '../../pages/api/refresh';
// eslint-disable-next-line import/first
import ideasHandler from '../../pages/api/ideas';
// eslint-disable-next-line import/first
import insightHandler from '../../pages/api/insight';
// eslint-disable-next-line import/first
import volumeHandler from '../../pages/api/volume';
// eslint-disable-next-line import/first
import domainsHandler from '../../pages/api/domains';
// eslint-disable-next-line import/first
import keywordsHandler from '../../pages/api/keywords';
// eslint-disable-next-line import/first
import cronHandler from '../../pages/api/cron';
// eslint-disable-next-line import/first
import searchconsoleHandler from '../../pages/api/searchconsole';
// eslint-disable-next-line import/first
import meHandler from '../../pages/api/me';
// eslint-disable-next-line import/first
import connectHandler from '../../pages/api/searchconsole/connect';

const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockVerifyUser = verifyUserFn as unknown as jest.Mock;
const mockKeyword = KeywordModel as unknown as { update: jest.Mock, findAll: jest.Mock };

const ADMIN = { ID: 1, name: 'admin', plan: 'admin', status: 'active' };

const makeReq = (opts: { method?: string, body?: unknown, query?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body ?? {},
   query: opts.query ?? {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: ADMIN, error: undefined });
   mockVerifyUser.mockReturnValue('authorized');
});

describe('A13: method mismatch returns 405, not 502', () => {
   // PATCH is handled by no route in pages/api, so it always reaches the method fallthrough.
   const patchRoutes: Array<[string, Handler]> = [
      ['clearfailed', clearfailedHandler],
      ['refresh', refreshHandler],
      ['ideas', ideasHandler],
      ['insight', insightHandler],
      ['volume', volumeHandler],
      ['domains', domainsHandler],
      ['keywords', keywordsHandler],
      ['cron', cronHandler],
      ['searchconsole', searchconsoleHandler],
   ];

   it.each(patchRoutes)('%s: PATCH -> 405', async (_name, handler) => {
      const res = makeRes();
      await handler(makeReq({ method: 'PATCH' }), res);
      expect(res.statusCode).toBe(405);
   });

   it('me: non-GET (POST) -> 405', async () => {
      const res = makeRes();
      await meHandler(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
   });

   it('searchconsole/connect: non-GET (POST) -> 405', async () => {
      const res = makeRes();
      await connectHandler(makeReq({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
   });
});

describe('A13: keywords.ts error path no longer returns 200', () => {
   it('PUT whose DB update throws -> 500 (server error, not 200)', async () => {
      mockKeyword.update.mockRejectedValueOnce(new Error('db down'));
      const res = makeRes();
      await keywordsHandler(makeReq({ method: 'PUT', query: { id: '1' }, body: { target_page: '/x' } }), res);
      expect(res.statusCode).toBe(500);
   });
});
