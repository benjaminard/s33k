// Migration: Creates the `setting` table (the single global operator-instance config row).
//
// This retires data/settings.json as the storage for instance config. The table holds ONE row
// (id = 1) whose `data` column is the full settings JSON blob, with the SAME cryptr-encrypted
// sensitive fields settings.json used. Moving it off the data volume removes a fragile shared file
// and makes the value durable in Postgres. See database/models/setting.ts for WHY it is one global
// row and not per-tenant (the operator runs the SERP scraper / SMTP / integrations).
//
// Column names/types BYTE-MATCH the model (Postgres is case-sensitive): the PK is the lowercase
// "id" (the fixed single row), and the blob is "data" TEXT (never STRING/VARCHAR(255), which would
// truncate the JSON on Postgres while passing on SQLite). The row itself is seeded lazily by the app
// on first read (getStoredSettings findOrCreate on id=1), importing an existing data/settings.json
// once if present, so this migration creates the table only.
//
// Dual-convention (Umzug v3 { context } and classic positional) + idempotent: only creates the table
// when absent. Safe on Postgres (prod) and SQLite (local) and safe to re-run.
//
// FAIL-LOUD: the idempotency probe (describeTable) is the ONLY thing wrapped in a swallowing
// try/catch, because a missing table throws there, which is the expected "not yet created" signal.
// The createTable path is intentionally NOT wrapped: a real failure must throw out of up() so Umzug
// leaves this migration un-applied and retryable. entrypoint.sh runs db:migrate on boot and exits
// non-zero on a migrate failure, so a swallowed error must never mark this APPLIED with no table.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY (see header). A missing table throws here and is caught as
         // exists=false. The createTable below is deliberately UNWRAPPED so a real failure throws
         // and the migration stays retryable.
         let exists = false;
         try {
            await queryInterface.describeTable('setting');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('setting', {
               id: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
               data: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('setting');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('setting', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
