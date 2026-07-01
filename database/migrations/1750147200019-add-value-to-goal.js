// Migration: Adds the nullable monetary `value` column to the goal table.
//
// value is the money a single completion of this goal is worth (e.g. a Demo Booked is worth 250).
// It is OPTIONAL: NULL means the goal has no assigned value, and every conversion read simply omits
// (or nulls) the revenue fields, so a value-less goal behaves exactly as before. When set, the
// conversion reads multiply conversions by value to answer "what is this conversion worth": total
// revenue, revenue per channel, and revenue per keyword-bearing page.
//
// FLOAT (not DECIMAL): the value is a directional monetary weight for ranking and rough revenue
// math, not a ledger figure, so float precision is fine and keeps the dialects consistent (SQLite
// has no native DECIMAL). Existing rows get NULL (no backfill: a goal defined before this column
// existed simply has no value until the user sets one).
//
// Dual-convention (Umzug v3 { context } and classic positional) + idempotent: only adds the column
// when absent. Works on Postgres (prod) and SQLite (local) and is safe to re-run.
//
// FAIL-LOUD: the idempotency probe (describeTable) is the ONLY thing wrapped in a swallowing
// try/catch, because a missing goal table on a brand-new DB must no-op (the goal table is created
// by an earlier migration). The addColumn path is intentionally NOT wrapped: a real failure MUST
// throw out of up() so Umzug leaves this migration un-applied and retryable. entrypoint.sh runs
// db:migrate on boot and does NOT exit on failure, so a swallowed error would mark this APPLIED with
// the column missing and every value-bearing read would then break with nothing left to re-run.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY: a missing goal table throws here and is caught so the migration
         // no-ops. Everything below is deliberately UNWRAPPED so a real failure throws and the
         // migration stays retryable.
         let tableDefinition = null;
         try {
            tableDefinition = await queryInterface.describeTable('goal');
         } catch (describeError) {
            tableDefinition = null;
         }
         if (!tableDefinition) { return; }
         if (!tableDefinition.value) {
            await queryInterface.addColumn('goal', 'value', { type: DataTypes.FLOAT, allowNull: true, defaultValue: null }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let tableDefinition = null;
            try {
               tableDefinition = await queryInterface.describeTable('goal');
            } catch (describeError) {
               tableDefinition = null;
            }
            if (!tableDefinition) { return; }
            if (tableDefinition.value) {
               await queryInterface.removeColumn('goal', 'value', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
