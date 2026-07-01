// Migration: Creates the goal table.
//
// goal stores one row per NAMED conversion a marketer defines (see database/models/goal.ts):
// kind 'page_reached' (a session viewed a path matching match_value) or 'event' (a session fired
// an autocaptured event of type match_value, optionally on match_page). It is the unit behind
// conversion-rate questions. owner_id mirrors the owning domain for tenant scoping (NULL == the
// legacy single-tenant admin account).
//
// Dual-convention (Umzug v3 { context } and classic positional) + idempotent: only creates the
// table when absent. Safe on Postgres (prod) and SQLite (local) and safe to re-run.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY: a missing table throws here, which is the expected
         // "not yet created" signal, so it is caught and treated as exists=false. The
         // create/addIndex path below is intentionally NOT wrapped: a real failure must
         // throw out of up() so Umzug leaves this migration un-applied and retryable.
         // entrypoint.sh runs db:migrate on boot and does not exit on failure, so a
         // swallowed error here would mark the migration APPLIED with no goal table and
         // every Goal read/create would throw forever with nothing left to re-run.
         let exists = false;
         try {
            await queryInterface.describeTable('goal');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('goal', {
               ID: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
               domain: { type: DataTypes.STRING, allowNull: false },
               owner_id: { type: DataTypes.INTEGER, allowNull: true },
               name: { type: DataTypes.STRING, allowNull: false },
               kind: { type: DataTypes.STRING, allowNull: false },
               match_value: { type: DataTypes.TEXT, allowNull: false },
               match_page: { type: DataTypes.TEXT, allowNull: true },
               match_mode: { type: DataTypes.STRING, allowNull: false, defaultValue: 'prefix' },
               created: { type: DataTypes.STRING, allowNull: false },
            }, { transaction: t });
            // Scope/lookup indexes.
            await queryInterface.addIndex('goal', ['domain'], { transaction: t });
            await queryInterface.addIndex('goal', ['owner_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('goal');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('goal', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
