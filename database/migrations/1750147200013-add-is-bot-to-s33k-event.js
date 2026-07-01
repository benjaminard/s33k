// Migration: Adds the `is_bot` boolean column to the s33k_event table.
//
// `is_bot` is the datacenter/hosting classification computed at ingest from the source IP
// (utils/datacenter-ip.ts). TRUE means the hit came from a known cloud/hosting range, the bot
// signal a JS pageview tracker cannot see. Human-only analytics (traffic, bounce, exit rate)
// filter is_bot = false by default. The IP itself is never stored; only this derived boolean.
//
// Existing rows default to false (treated as human) so no backfill is needed. Same dual-convention
// (Umzug v3 { context } and classic positional) + idempotent pattern as the sibling migrations, so
// it is safe on Postgres (prod) and SQLite (local) and safe to re-run.

const { DataTypes } = require('sequelize');

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotent: only touch the table when it exists and the column is absent.
         let tableDefinition = null;
         try {
            tableDefinition = await queryInterface.describeTable('s33k_event');
         } catch (describeError) {
            tableDefinition = null;
         }
         if (tableDefinition && !tableDefinition.is_bot) {
            await queryInterface.addColumn('s33k_event', 'is_bot', {
               type: DataTypes.BOOLEAN,
               allowNull: false,
               defaultValue: false,
            }, { transaction: t });
            // Index is_bot so the human-only (is_bot = false) filter on every read stays cheap.
            await queryInterface.addIndex('s33k_event', ['is_bot'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let tableDefinition = null;
            try {
               tableDefinition = await queryInterface.describeTable('s33k_event');
            } catch (describeError) {
               tableDefinition = null;
            }
            if (tableDefinition && tableDefinition.is_bot) {
               await queryInterface.removeColumn('s33k_event', 'is_bot', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
