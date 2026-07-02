// Migration: Add the hot-path s33k_event indexes that high event volume needs and that no earlier
// migration created.
//
// WHY: the per-domain read predicates that were fine at low volume become the hot paths the
// planner must serve from an index, not a scan. The indexes below cover exactly the shapes the
// code already uses that are NOT indexed today:
//   s33k_event (session)            sessionization (utils/sessionize.ts, entry-page / engagement
//                                   joins) groups events by session; with no index this is a scan
//                                   of the whole event partition per session lookup.
//   s33k_event (domain, type, created)  the by-type window read (e.g. pageviews / conversions for a
//                                   domain in a time range): equality on domain + type, range/sort
//                                   on created. The existing (domain, created) composite from
//                                   migration 016 does not cover the type equality, so a type-
//                                   filtered window still filters in memory.
//
// Single-user squash (2026-07): this migration originally also added an index on
// account (stripe_customer_id) for the Stripe billing webhook. The SaaS account table is no longer
// created by any migration and the runtime never reads it, so that entry was removed from INDEXES.
// On an EXISTING install this migration already ran (its SequelizeMeta row exists) and never
// re-runs, so a leftover account_stripe_customer_id index there is harmless and simply stays.
//
// What is DELIBERATELY NOT added here (already indexed by an earlier migration, so a second index
// would be redundant write-amplification with no read benefit):
//   s33k_event (owner_id)   already created in migration 1750147200009 (create-s33k-event-table).
//
// Dialect safety: queryInterface.addIndex is dialect-agnostic (Postgres + SQLite), quotes its own
// identifiers, and preserves the exact lowercase column case (session, domain, type, created)
// that the create-table migrations and models use. Postgres is case-sensitive;
// every column name below byte-matches its model definition.
//
// Idempotency + FAIL-LOUD: migrations run on boot (entrypoint.sh, sequelize-cli db:migrate). We
// guard ONLY idempotency (skip an index already present, checked via showIndex; skip a table or
// column that does not exist on a fresh/partial DB) and let a genuine addIndex failure THROW, so a
// broken index never boots silently with slow reads. Same structure as migration
// 1750147200016-add-performance-indexes.js. Dual-convention (Umzug v3 { context } + classic positional).

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// Each index: the table, its column list, and an explicit stable name so down() can drop it
// deterministically and the name is identical across dialects (SQLite and Postgres auto-name differently).
const INDEXES = [
   { table: 's33k_event', columns: ['session'], name: 's33k_event_session' },
   { table: 's33k_event', columns: ['domain', 'type', 'created'], name: 's33k_event_domain_type_created' },
];

// Describe a table, returning null instead of throwing when the table does not exist (fresh or
// partially migrated DB), so we can skip indexes for tables that are not present yet.
const safeDescribeTable = async (queryInterface, table) => {
   try {
      return await queryInterface.describeTable(table);
   } catch (error) {
      return null;
   }
};

// True when an index with this name already exists on the table (idempotency guard). showIndex
// returns one entry per existing index; we match on the name we assign in INDEXES.
const indexExists = async (queryInterface, table, name) => {
   const existing = await queryInterface.showIndex(table);
   return existing.some((index) => index.name === name);
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      const describedTables = {};
      for (const { table, columns, name } of INDEXES) {
         if (!(table in describedTables)) {
            describedTables[table] = await safeDescribeTable(queryInterface, table);
         }
         const definition = describedTables[table];
         // Skip cleanly when the table or any target column is absent (fresh/partial DB), so this
         // migration is safe on any schema state and never invents an index on a missing column.
         if (!definition) { continue; }
         if (columns.some((column) => !definition[column])) { continue; }
         // Idempotency guard ONLY: skip if already present. A real addIndex failure below is left
         // to throw so a boot-time migration run fails loud instead of silently leaving reads slow.
         if (await indexExists(queryInterface, table, name)) { continue; }
         await queryInterface.addIndex(table, columns, { name });
      }
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      for (const { table, name } of INDEXES) {
         // Only drop an index this migration could have added, and only if the table still exists.
         const definition = await safeDescribeTable(queryInterface, table);
         if (!definition) { continue; }
         if (!(await indexExists(queryInterface, table, name))) { continue; }
         await queryInterface.removeIndex(table, name);
      }
   },
};
