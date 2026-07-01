/**
 * Tests for the memoized one-time schema sync (database/database.ts ensureSynced).
 *
 * SECURITY (audit area 1): route handlers used to call db.sync() on EVERY request, a per-request
 * metadata round-trip that an unauthenticated flood could amplify into heavy DB load before the
 * rate limiter ran. ensureSynced() must run the underlying sync EXACTLY ONCE per process and be a
 * cheap awaited no-op thereafter, and must NOT cache a failed sync (so a transient boot failure can
 * be retried). These tests assert that contract.
 *
 * The real database module transitively loads sequelize, whose ESM dependency chain (uuid) jest
 * cannot transform, so we mock sequelize-typescript with a fake Sequelize whose sync() is a jest
 * spy, and stub the dialect drivers + every model import so the module under test loads cleanly.
 * This isolates the memoization logic, which is the actual behavior under test.
 */

const syncMock = jest.fn();

jest.mock('sequelize-typescript', () => ({
   __esModule: true,
   // The module does `new Sequelize(...)` then calls `.sync()`. A class whose sync delegates to the
   // shared spy lets us assert call counts regardless of which dialect branch the module picks.
   Sequelize: jest.fn().mockImplementation(() => ({ sync: syncMock })),
}));
jest.mock('sqlite3', () => ({ __esModule: true, default: {} }));
jest.mock('pg', () => ({ __esModule: true, default: {} }));

// Every model import is a no-op object; the module only puts them in a `models` array.
// Single-user: the surviving tables are domain, keyword, crawlerHit, s33kEvent, goal, segment,
// promptCheck, setting. The SaaS tables (account, api_key, invite, waitlist, feature_request,
// audit_log, rate_limit) were removed from the models array.
const modelStub = { __esModule: true, default: {} };
jest.mock('../../database/models/domain', () => modelStub);
jest.mock('../../database/models/keyword', () => modelStub);
jest.mock('../../database/models/crawlerHit', () => modelStub);
jest.mock('../../database/models/s33kEvent', () => modelStub);
jest.mock('../../database/models/goal', () => modelStub);
jest.mock('../../database/models/segment', () => modelStub);
jest.mock('../../database/models/promptCheck', () => modelStub);
jest.mock('../../database/models/setting', () => modelStub);

describe('ensureSynced', () => {
   beforeEach(() => {
      jest.resetModules();
      syncMock.mockReset();
   });

   it('invokes the underlying sync only once across many concurrent and serial calls', async () => {
      syncMock.mockResolvedValue(undefined);
      // eslint-disable-next-line global-require
      const { ensureSynced } = require('../../database/database');

      await Promise.all([ensureSynced(), ensureSynced(), ensureSynced()]);
      await ensureSynced();

      expect(syncMock).toHaveBeenCalledTimes(1);
   });

   it('returns a resolved void no-op on the cached path', async () => {
      syncMock.mockResolvedValue(undefined);
      // eslint-disable-next-line global-require
      const { ensureSynced } = require('../../database/database');

      await expect(ensureSynced()).resolves.toBeUndefined();
      await expect(ensureSynced()).resolves.toBeUndefined();
   });

   it('does not cache a failed sync: a later call retries', async () => {
      syncMock.mockRejectedValueOnce(new Error('db not ready')).mockResolvedValueOnce(undefined);
      // eslint-disable-next-line global-require
      const { ensureSynced } = require('../../database/database');

      await expect(ensureSynced()).rejects.toThrow('db not ready');
      // The failed attempt cleared the memo, so this call actually retries sync (second invocation).
      await expect(ensureSynced()).resolves.toBeUndefined();
      expect(syncMock).toHaveBeenCalledTimes(2);
   });
});
