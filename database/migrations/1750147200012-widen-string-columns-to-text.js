// Migration: Widen every STRING column that can legitimately exceed 255 characters to TEXT on
// Postgres.
//
// THE BUG this fixes: sequelize DataType.STRING maps to VARCHAR(255) on Postgres but to unlimited
// TEXT on SQLite. Any STRING column that holds a JSON blob, free text, a long URL/path, or any
// other unbounded value silently breaks on Postgres with real data ("value too long for type
// character varying(255)") while passing every test, because the test suite runs on SQLite where
// VARCHAR length is not enforced. The confirmed prod failure: keyword.lastResult (a 100-result
// SERP JSON payload) and keyword.history overflow VARCHAR(255), so rank tracking, the core
// feature, never persists on Postgres.
//
// The model definitions are now TEXT, which fixes FRESH deploys on both dialects. This migration
// fixes the EXISTING Postgres prod DB by widening each affected column in place. ALTER COLUMN ...
// TYPE TEXT is a non-destructive widen: no data is lost, and on a column already TEXT it is a
// clean no-op, so this migration is safe to re-run.
//
// On SQLite this migration is intentionally a no-op: SQLite does not enforce VARCHAR length and
// STRING/TEXT share TEXT affinity, so there is nothing to change and an unguarded ALTER would not
// even map cleanly.
//
// Idempotency + fresh-DB safety: we gate the whole body on the Postgres dialect, then for each
// column we first confirm the table and column exist via describeTable (so a fresh or partially
// migrated DB skips anything not present), and wrap each ALTER in its own try/catch so a single
// failure can never abort the rest or the migration as a whole.
//
// This file supports both the Umzug v3 calling convention used by the app at /api/dbmigrate (a
// single { context } object, where context is the Sequelize QueryInterface) and the classic
// sequelize-cli convention (positional (queryInterface, Sequelize)). We normalise both.

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// Every (table, column) pair whose model is now DataType.TEXT and that can hold > 255 chars.
// Kept in lockstep with the model edits in this same change. Short fixed fields (timestamps,
// enums, hostnames-as-slug, hashes, prefixes, UUIDs) are deliberately NOT here and stay STRING.
const COLUMNS_TO_WIDEN = [
   ['keyword', 'keyword'],
   ['keyword', 'domain'],
   ['keyword', 'history'],
   ['keyword', 'url'],
   ['keyword', 'target_page'],
   ['keyword', 'tags'],
   ['keyword', 'lastResult'],
   ['keyword', 'lastUpdateError'],
   ['keyword', 'settings'],
   ['domain', 'domain'],
   ['domain', 'tags'],
   ['domain', 'notification_emails'],
   ['domain', 'search_console'],
   ['domain', 'scrape_strategy'],
   ['domain', 'subdomain_matching'],
   ['crawler_hit', 'path'],
   ['crawler_hit', 'userAgent'],
   ['s33k_event', 'page'],
   ['s33k_event', 'label'],
   ['s33k_event', 'selector'],
   // Single-user squash (2026-07): the ['waitlist', 'note'] entry was removed. No migration creates
   // the retired SaaS tables anymore, so on a fresh install the entry could only ever be skipped by
   // the safeDescribeTable guard below; on an existing install this migration already ran (its
   // SequelizeMeta row exists) and never re-runs, so nothing changes there.
];

// Describe a table, returning null instead of throwing when the table does not exist (fresh DB).
const safeDescribeTable = async (queryInterface, table) => {
   try {
      return await queryInterface.describeTable(table);
   } catch (error) {
      return null;
   }
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      // Postgres is the only dialect where STRING (VARCHAR(255)) is a problem; SQLite is a no-op.
      if (queryInterface.sequelize.getDialect() !== 'postgres') { return; }

      const describedTables = {};
      // Attempt every column, then FAIL the migration if any real ALTER failed. A genuinely
      // absent column (fresh DB) is skipped and is NOT a failure; an ALTER that throws IS, and
      // must not be swallowed, or Umzug records the migration as applied while columns are still
      // VARCHAR(255) and the original overflow bug silently returns (security review #8).
      const failures = [];
      for (const [table, column] of COLUMNS_TO_WIDEN) {
         if (!(table in describedTables)) {
            describedTables[table] = await safeDescribeTable(queryInterface, table);
         }
         const definition = describedTables[table];
         // Skip anything not present yet on this DB so the migration is safe on a fresh schema.
         if (!definition || !definition[column]) { continue; }
         try {
            // ALTER ... TYPE TEXT is a non-destructive widen and a clean no-op when already TEXT,
            // which is what makes re-running safe. Identifiers are quoted to preserve case
            // (userAgent) and avoid any reserved-word collisions.
            await queryInterface.sequelize.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TEXT`);
         } catch (error) {
            console.log(`widen-string-columns-to-text: FAILED ${table}.${column}:`, error.message);
            failures.push(`${table}.${column}: ${error.message}`);
         }
      }
      if (failures.length > 0) {
         throw new Error(`widen-string-columns-to-text: ${failures.length} column(s) failed to widen to TEXT: ${failures.join('; ')}`);
      }
   },
   // No down migration: narrowing TEXT back to VARCHAR(255) would risk truncating real data that
   // legitimately exceeds 255 chars (the exact failure this migration exists to prevent). The
   // widen is intentionally one-way.
   down: async () => {},
};
