/**
 * A13: status-code standardization for the legacy SerpBear settings + clearfailed routes.
 *
 * These two routes previously returned a 200 SUCCESS status on actual error paths. Corrected:
 *   - settings.ts: unhandled method -> 405 (was 502); missing body -> 400 (was 200); write
 *     failure -> 500 (was 200).
 *   - clearfailed.ts: write failure -> 500 (was 200). (Its 405 method-mismatch is covered in
 *     route-status-codes.test.ts.)
 *
 * Storage moved from data/settings.json + data/failed_queue.json to Postgres (the `setting` row and
 * the keyword rows). So the write-failure paths are now a DB write throwing, not a file write: we
 * mock the settings store (writeStoredSettings) and the Keyword model (clearfailed's Keyword.update),
 * plus the scraper helpers settings/clearfailed import (cheerio is untranspiled ESM jest cannot parse).
 */

jest.mock('../../utils/verifyUser', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../scrapers/index', () => ({ __esModule: true, default: [] }));
// The DB-backed settings store: getStoredSettings returns empty, writeStoredSettings is the write path.
jest.mock('../../utils/settingsStore', () => ({
   __esModule: true,
   getStoredSettings: jest.fn(async () => ({})),
   writeStoredSettings: jest.fn(async () => undefined),
}));
// scraper imports cheerio; stub the helpers settings.ts (getFailedRetryKeywordIds) and clearfailed.ts
// (failedRetryWhere) pull from it.
jest.mock('../../utils/scraper', () => ({
   __esModule: true,
   getFailedRetryKeywordIds: jest.fn(async () => []),
   failedRetryWhere: jest.fn(() => ({})),
}));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn() }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { update: jest.fn(async () => [0]) } }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import verifyUserFn from '../../utils/verifyUser';
// eslint-disable-next-line import/first
import { writeStoredSettings } from '../../utils/settingsStore';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import settingsHandler from '../../pages/api/settings';

const mockVerifyUser = verifyUserFn as unknown as jest.Mock;
const mockWriteStored = writeStoredSettings as unknown as jest.Mock;
const mockKeywordUpdate = (KeywordModel as unknown as { update: jest.Mock }).update;

const makeReq = (opts: { method?: string, body?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body ?? {},
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
   mockVerifyUser.mockReturnValue('authorized');
   mockWriteStored.mockResolvedValue(undefined);
   mockKeywordUpdate.mockResolvedValue([0]);
   process.env.SECRET = process.env.SECRET || 'test-secret-value-1234567890';
});

describe('A13 settings.ts', () => {
   it('PATCH (unhandled method) -> 405, not 502', async () => {
      const res = makeRes();
      await settingsHandler(makeReq({ method: 'PATCH' }), res);
      expect(res.statusCode).toBe(405);
   });

   it('PUT with missing body -> 400 (client error, not 200)', async () => {
      const res = makeRes();
      await settingsHandler(makeReq({ method: 'PUT', body: {} }), res);
      expect(res.statusCode).toBe(400);
   });

   it('PUT whose DB write fails -> 500 (server error, not 200)', async () => {
      mockWriteStored.mockRejectedValueOnce(new Error('db down'));
      const res = makeRes();
      await settingsHandler(makeReq({ method: 'PUT', body: { settings: { scraper_type: 'none' } } }), res);
      expect(res.statusCode).toBe(500);
   });
});

describe('A13 clearfailed.ts', () => {
   // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
   const clearfailedHandler = require('../../pages/api/clearfailed').default;

   it('PUT whose DB write fails -> 500 (server error, not 200)', async () => {
      mockKeywordUpdate.mockRejectedValueOnce(new Error('db down'));
      const res = makeRes();
      await clearfailedHandler(makeReq({ method: 'PUT' }), res);
      expect(res.statusCode).toBe(500);
   });
});
