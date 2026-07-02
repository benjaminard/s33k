import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Tests for the DB-backed hourly retry job: POST /api/cron?mode=retry.
 *
 * This replaces the old failed_queue.json + /api/refresh?id=... path. The route finds keywords that
 * currently have a real lastUpdateError (failedRetryWhere) and re-scrapes ONLY those, reusing the same
 * Bearer auth as the full scrape. Single-user: scopeWhere is {}, so the sweep covers all keywords.
 *
 * No network, no DB: models + refresh + settings + scraper helper + authorize are mocked.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { update: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => []) }));
// scraper imports cheerio; the route only needs failedRetryWhere from it (stubbed to a sentinel where).
const RETRY_WHERE = { __retry: true };
jest.mock('../../utils/scraper', () => ({ __esModule: true, failedRetryWhere: jest.fn(() => RETRY_WHERE) }));

// eslint-disable-next-line import/first
import cronHandler from '../../pages/api/cron';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import refreshFn from '../../utils/refresh';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

const mockKeyword = KeywordModel as unknown as { update: jest.Mock, findAll: jest.Mock };
const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockRefresh = refreshFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

// A keyword mock whose .get('ID') answers for the id mark.
const kw = (id: number) => ({
   ID: id,
   get: (k: string) => {
      if (k === 'ID') { return id; }
      return ({ ID: id });
   },
});

const makeReq = (query: Record<string, unknown> = {}): NextApiRequest => ({
   method: 'POST', body: {}, query, headers: { authorization: 'Bearer admin' }, socket: { remoteAddress: '127.0.0.1' },
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
   mockKeyword.update.mockResolvedValue([0]);
   mockDomain.findAll.mockResolvedValue([]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/cron?mode=retry', () => {
   it('refreshes exactly the keywords returned by the failed-retry query', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
      const errored = [kw(11), kw(22)];
      mockKeyword.findAll.mockResolvedValue(errored);

      const res = makeRes();
      await cronHandler(makeReq({ mode: 'retry' }), res);

      expect(res.statusCode).toBe(200);
      // The findAll where included the failed-retry fragment (the retry set, not all keywords).
      expect(mockKeyword.findAll.mock.calls[0][0].where).toEqual(expect.objectContaining(RETRY_WHERE));
      // refresh was called with exactly the errored keywords.
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockRefresh.mock.calls[0][0]).toEqual(errored);
   });

   it('does nothing (but 200) when no keyword needs a retry', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
      mockKeyword.findAll.mockResolvedValue([]);

      const res = makeRes();
      await cronHandler(makeReq({ mode: 'retry' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockRefresh).not.toHaveBeenCalled();
   });
});

describe('POST /api/cron with an unknown mode', () => {
   // Regression guard: a leftover mode=dunning cron used to fall through to the FULL scrape,
   // silently spending SERP credits daily. Unknown modes must be rejected, never scrape.
   it('rejects unknown modes with 400 and never touches keywords', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });

      const res = makeRes();
      await cronHandler(makeReq({ mode: 'dunning' }), res);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual(expect.objectContaining({ started: false }));
      expect(mockKeyword.findAll).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
   });
});
