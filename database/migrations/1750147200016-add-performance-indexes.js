// Migration: Add composite indexes covering the hot analytics/SEO read predicates.
//
// WHY: every analytics route scopes by domain and a time window (S33kEvent: domain + created >=
// cutoff, very often also is_bot = false; CrawlerHit: domain + hitAt range), and every keyword
// read filters by domain. On a high-volume domain (example.com is ~58% bots, so the event table
// fills fast) a single-column index on `domain` alone is nearly useless: every row for a given
// site shares one domain value, so the planner still has to scan and filter the whole domain
// partition by time. The composites below let one index serve the (equality on domain) +
// (range on created/hitAt) shape that the hot reads actually use.
//
// What is NEW here (the singles already created by earlier migrations are deliberately left alone):
//   s33k_event  (domain, created)           the core "events for this domain in this window" read
//   s33k_event  (domain, is_bot, created)   the very common bot-filtered window (human-analytics,
//                                           page-engagement, conversions all add is_bot = false)
//   crawler_hit (domain, hitAt)             the ai-crawlers / aeo reads: domain filter + hitAt range/sort
//   keyword     (domain)                    every keyword read is where: { domain }; today keyword
//                                           has only an owner_id index, so domain reads are unindexed
//
// Dialect safety: queryInterface.addIndex is dialect-agnostic (works on both Postgres and SQLite)
// and quotes identifiers itself, so the exact column case (created, hitAt, is_bot, domain) is
// preserved without raw dialect-specific SQL.
//
// Idempotency + FAIL-LOUD: migrations run on boot via entrypoint.sh (sequelize-cli db:migrate),
// which does NOT exit on failure, so a swallowed error would let the app boot believing the index
// exists when it does not, and the hot reads silently stay slow. So we guard ONLY idempotency
// (skip an index already present, checked via showIndex) and let a genuine addIndex failure THROW.
//
// This file supports both the Umzug v3 calling convention used by the app at /api/dbmigrate (a
// single { context } object, where context is the Sequelize QueryInterface) and the classic
// sequelize-cli convention (positional (queryInterface, Sequelize)). We normalise both.

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// Each index: the table, its column list, and an explicit name so down() can drop it deterministically
// and so the name is stable across dialects (SQLite and Postgres derive auto-names differently).
const INDEXES = [
   { table: 's33k_event', columns: ['domain', 'created'], name: 's33k_event_domain_created' },
   { table: 's33k_event', columns: ['domain', 'is_bot', 'created'], name: 's33k_event_domain_is_bot_created' },
   { table: 'crawler_hit', columns: ['domain', 'hitAt'], name: 'crawler_hit_domain_hit_at' },
   { table: 'keyword', columns: ['domain'], name: 'keyword_domain' },
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
