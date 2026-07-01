/* eslint-disable global-require, @typescript-eslint/no-var-requires */

/**
 * Phase 3 scale test: the add-scale-indexes migration creates the missing hot-path indexes and is
 * idempotent (a re-run is a clean no-op), with table/column skip-safety on a fresh/partial DB.
 *
 * We drive the migration against an in-memory FAKE QueryInterface rather than a real Sequelize. The
 * real `sequelize` package transitively imports uuid's ESM build, which jest cannot transform here
 * (the documented repo trap in CLAUDE.md A). The migration only depends on the small QueryInterface
 * surface (describeTable / showIndex / addIndex / removeIndex), and it is dialect-agnostic by design,
 * so a faithful fake exercises the exact branching (column-present guard, idempotency guard, throw on
 * a real failure) without the ESM chain. The fake mirrors the contracts the migration relies on:
 *   - describeTable throws for an unknown table (so safeDescribeTable returns null and the table is skipped),
 *   - showIndex returns [{ name }] entries,
 *   - addIndex creates a named index and THROWS on a duplicate name (proving the idempotency guard
 *     is what prevents the throw, not luck).
 */

const migration = require('../../database/migrations/1750147200030-add-scale-indexes.js');

type Table = { columns: Set<string>, indexes: Set<string> };

const makeFakeQueryInterface = (tables: Record<string, Table>) => ({
   describeTable: async (table: string) => {
      const t = tables[table];
      if (!t) { throw new Error(`No description found for "${table}"`); }
      const def: Record<string, unknown> = {};
      t.columns.forEach((c) => { def[c] = { type: 'TEXT' }; });
      return def;
   },
   showIndex: async (table: string) => {
      const t = tables[table];
      if (!t) { throw new Error(`No description found for "${table}"`); }
      return Array.from(t.indexes).map((name) => ({ name }));
   },
   addIndex: async (table: string, _columns: string[], opts: { name: string }) => {
      const t = tables[table];
      if (!t) { throw new Error(`No table "${table}"`); }
      if (t.indexes.has(opts.name)) { throw new Error(`index ${opts.name} already exists`); }
      t.indexes.add(opts.name);
   },
   removeIndex: async (table: string, name: string) => {
      const t = tables[table];
      if (t) { t.indexes.delete(name); }
   },
});

const EXPECTED = ['s33k_event_session', 's33k_event_domain_type_created', 'account_stripe_customer_id'];

const freshTables = (): Record<string, Table> => ({
   s33k_event: {
      columns: new Set(['id', 'domain', 'owner_id', 'type', 'session', 'created']),
      // owner_id already indexed by an earlier migration; this migration must NOT touch it.
      indexes: new Set(['s33k_event_owner_id']),
   },
   account: {
      columns: new Set(['ID', 'stripe_customer_id']),
      indexes: new Set(),
   },
});

describe('1750147200030-add-scale-indexes', () => {
   it('creates the three missing hot-path indexes', async () => {
      const tables = freshTables();
      await migration.up({ context: makeFakeQueryInterface(tables) });
      expect(tables.s33k_event.indexes.has('s33k_event_session')).toBe(true);
      expect(tables.s33k_event.indexes.has('s33k_event_domain_type_created')).toBe(true);
      expect(tables.account.indexes.has('account_stripe_customer_id')).toBe(true);
      // The pre-existing owner_id index is untouched (no duplicate / no removal).
      expect(tables.s33k_event.indexes.has('s33k_event_owner_id')).toBe(true);
   });

   it('is idempotent: a second up() adds no further indexes and does not throw', async () => {
      const tables = freshTables();
      const qi = makeFakeQueryInterface(tables);
      await migration.up({ context: qi });
      const after1 = new Set([...tables.s33k_event.indexes, ...tables.account.indexes]);
      // Re-run: the fake addIndex THROWS on a duplicate name, so a passing run PROVES the
      // idempotency guard skipped the already-present indexes rather than re-adding them.
      await expect(migration.up({ context: qi })).resolves.not.toThrow();
      const after2 = new Set([...tables.s33k_event.indexes, ...tables.account.indexes]);
      expect(Array.from(after2).sort()).toEqual(Array.from(after1).sort());
      EXPECTED.forEach((name) => expect(after2.has(name)).toBe(true));
   });

   it('skips cleanly when a target table does not exist (fresh/partial DB)', async () => {
      const tables = freshTables();
      delete tables.account;
      await expect(migration.up({ context: makeFakeQueryInterface(tables) })).resolves.not.toThrow();
      // s33k_event indexes still created; the missing account table is simply skipped.
      expect(tables.s33k_event.indexes.has('s33k_event_session')).toBe(true);
      expect(tables.s33k_event.indexes.has('s33k_event_domain_type_created')).toBe(true);
   });

   it('skips an index whose target column is absent on the model', async () => {
      const tables = freshTables();
      tables.s33k_event.columns.delete('session');
      await migration.up({ context: makeFakeQueryInterface(tables) });
      // session column gone -> that index is skipped; the (domain, type, created) one still lands.
      expect(tables.s33k_event.indexes.has('s33k_event_session')).toBe(false);
      expect(tables.s33k_event.indexes.has('s33k_event_domain_type_created')).toBe(true);
   });

   it('down() removes the indexes it added and leaves pre-existing ones alone', async () => {
      const tables = freshTables();
      const qi = makeFakeQueryInterface(tables);
      await migration.up({ context: qi });
      await migration.down({ context: qi });
      expect(tables.s33k_event.indexes.has('s33k_event_session')).toBe(false);
      expect(tables.s33k_event.indexes.has('s33k_event_domain_type_created')).toBe(false);
      expect(tables.account.indexes.has('account_stripe_customer_id')).toBe(false);
      // The owner_id index this migration never created must survive down().
      expect(tables.s33k_event.indexes.has('s33k_event_owner_id')).toBe(true);
   });
});
