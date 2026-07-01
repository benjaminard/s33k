import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Paged-drain tests for POST /api/cron (the full rank scrape).
 *
 * The scrape runs as a fire-and-forget background DRAIN: the handler returns started:true immediately,
 * then a paged loop claims the stalest not-currently-updating, not-yet-seen keywords one bounded page
 * at a time until the set is exhausted. This replaces the interim single-page form that silently
 * starved every keyword past the first page (at 1000 sites that was ~99% of keywords never scraped).
 *
 * These tests prove the two properties that fix earns:
 *   1. The drain pages BEYOND the first page (every keyword is scraped, not just the first CRON_PAGE_SIZE).
 *   2. The in-process mutex makes an overlapping second fire a no-op (no double-charge to Serper).
 *
 * No network, no DB: models + refresh + settings + authorize are mocked. The Keyword.findAll mock
 * models the DB honoring the seen-set cursor by returning each page in sequence then an empty page.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), notIn: Symbol('notIn') } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { update: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => []) }));
jest.mock('../../utils/scraper', () => ({ __esModule: true, failedRetryWhere: jest.fn(() => ({})) }));

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

const kw = (id: number) => ({ ID: id, get: (k: string) => (k === 'owner_id' ? null : id) });

const makeReq = (): NextApiRequest => ({
   method: 'POST', body: {}, query: {}, headers: { authorization: 'Bearer admin' }, socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

const flushDrain = async (ticks = 40) => {
   for (let i = 0; i < ticks; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 0); });
   }
};

// Every id the background drain handed to refresh, flattened across all pages.
const scrapedIds = (): number[] => mockRefresh.mock.calls.flatMap((c) => (c[0] as Array<{ ID: number }>).map((k) => k.ID)).sort((a, b) => a - b);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.CRON_PAGE_SIZE = '2';
   mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
   mockKeyword.update.mockResolvedValue([0]);
   mockDomain.findAll.mockResolvedValue([]);
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/cron: background paged drain', () => {
   it('pages beyond the first page so EVERY keyword is scraped, not just the first CRON_PAGE_SIZE', async () => {
      // Page size 2, five keywords: the drain must run 3 pages (2 + 2 + 1) and scrape all five. The
      // single-page form would have scraped only [1, 2] and starved [3, 4, 5].
      mockKeyword.findAll
         .mockResolvedValueOnce([kw(1), kw(2)])
         .mockResolvedValueOnce([kw(3), kw(4)])
         .mockResolvedValueOnce([kw(5)])
         .mockResolvedValue([]);
      const res = makeRes();

      await cronHandler(makeReq(), res);
      expect(res.statusCode).toBe(200);
      expect((res as unknown as { payload: { started: boolean } }).payload.started).toBe(true);

      await flushDrain();

      expect(scrapedIds()).toEqual([1, 2, 3, 4, 5]);
   });

   it('an overlapping second fire while a drain is in flight is a no-op (no double scrape)', async () => {
      // A never-emptying page stream would loop forever, but the seen-set + a slow refresh keep the
      // first drain "in flight" long enough for the second fire to hit the mutex. We model a single
      // page then idle: the first fire owns the drain; the second fire (before the first releases)
      // must return started:true WITHOUT starting a second drain.
      let releaseFirstRefresh: () => void = () => undefined;
      const firstRefreshGate = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
      mockRefresh.mockImplementationOnce(async () => { await firstRefreshGate; return []; });
      mockKeyword.findAll.mockResolvedValueOnce([kw(1), kw(2)]).mockResolvedValue([]);

      const res1 = makeRes();
      await cronHandler(makeReq(), res1); // starts the drain; refresh now blocked on the gate
      await flushDrain(5); // let the drain reach the blocked refresh

      const res2 = makeRes();
      await cronHandler(makeReq(), res2); // should hit the in-flight mutex
      expect((res2 as unknown as { payload: { started: boolean } }).payload.started).toBe(true);

      releaseFirstRefresh(); // let the first drain finish
      await flushDrain();

      // Only the first drain ran: refresh was invoked once, for the one page of keywords.
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(scrapedIds()).toEqual([1, 2]);
   });
});
