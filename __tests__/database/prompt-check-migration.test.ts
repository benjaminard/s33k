/**
 * prompt_check create-table migration: shape + idempotency + fail-loud.
 *
 * Runs the migration against a stub queryInterface (no real DB) to assert it creates the table with
 * the exact columns the model needs, is idempotent (a present table no-ops), and is fail-loud (a real
 * createTable failure throws out of up() so Umzug leaves it retryable).
 */
// The migration does `require('sequelize')` for DataTypes; the real sequelize drags in an ESM uuid
// build jest cannot transform (the same reason the other DB guards read files as TEXT). Mock it with
// just the DataTypes shape the migration touches. Each DataType is a sentinel; the migration only
// passes them through to createTable, so identity is all that matters.
jest.mock('sequelize', () => ({
   __esModule: true,
   DataTypes: { INTEGER: 'INTEGER', TEXT: 'TEXT', BOOLEAN: 'BOOLEAN', DATE: 'DATE' },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires, import/no-dynamic-require, global-require
const migration = require('../../database/migrations/1750147200022-create-prompt-check-table.js');

type Stub = {
   describeTable: jest.Mock,
   createTable: jest.Mock,
   addIndex: jest.Mock,
   dropTable: jest.Mock,
   sequelize: { transaction: (fn: (t: unknown) => unknown) => unknown },
};

const makeStub = (over: Partial<Stub> = {}): Stub => ({
   describeTable: jest.fn(),
   createTable: jest.fn(async () => undefined),
   addIndex: jest.fn(async () => undefined),
   dropTable: jest.fn(async () => undefined),
   sequelize: { transaction: async (fn: (t: unknown) => unknown) => fn({}) },
   ...over,
});

describe('1750147200022-create-prompt-check-table', () => {
   it('creates prompt_check with the model columns when the table is absent', async () => {
      const qi = makeStub({ describeTable: jest.fn(async () => { throw new Error('no such table'); }) });
      await migration.up(qi);
      expect(qi.createTable).toHaveBeenCalledTimes(1);
      const [table, cols] = qi.createTable.mock.calls[0];
      expect(table).toBe('prompt_check');
      // PK is "ID" (case-exact with the model), and every result/free-text column exists.
      expect(Object.keys(cols)).toEqual(
         expect.arrayContaining(['ID', 'domain', 'owner_id', 'prompt', 'engine', 'cited', 'position', 'cited_url', 'checked_at', 'created']),
      );
      expect(cols.ID.primaryKey).toBe(true);
      expect(qi.addIndex).toHaveBeenCalledWith('prompt_check', ['domain'], expect.anything());
      expect(qi.addIndex).toHaveBeenCalledWith('prompt_check', ['domain', 'owner_id'], expect.anything());
   });

   it('is idempotent: no create when the table already exists', async () => {
      const qi = makeStub({ describeTable: jest.fn(async () => ({ ID: {} })) });
      await migration.up(qi);
      expect(qi.createTable).not.toHaveBeenCalled();
   });

   it('is fail-loud: a real createTable failure throws out of up()', async () => {
      const qi = makeStub({
         describeTable: jest.fn(async () => { throw new Error('no such table'); }),
         createTable: jest.fn(async () => { throw new Error('disk full'); }),
      });
      await expect(migration.up(qi)).rejects.toThrow('disk full');
   });

   it('down drops the table when present', async () => {
      const qi = makeStub({ describeTable: jest.fn(async () => ({ ID: {} })) });
      await migration.down(qi);
      expect(qi.dropTable).toHaveBeenCalledWith('prompt_check', expect.anything());
   });

   it('supports the Umzug v3 { context } convention', async () => {
      const inner = makeStub({ describeTable: jest.fn(async () => { throw new Error('no such table'); }) });
      await migration.up({ context: inner });
      expect(inner.createTable).toHaveBeenCalledTimes(1);
   });
});
