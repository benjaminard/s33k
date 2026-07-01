// Migration: Creates the segment table.
//
// segment stores one row per NAMED, reusable filter set a marketer defines (see
// database/models/segment.ts). `filters` is a JSON string of the SegmentFilters spec that
// parseSegmentFilters (utils/sessionize.ts) understands, so a named segment applies through the same
// engine as human-analytics and goal-analytics. owner_id mirrors the owning domain for tenant
// scoping (NULL == the legacy single-tenant admin account).
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
         // swallowed error here would mark the migration APPLIED with no segment table and
         // every Segment read/create would throw forever with nothing left to re-run.
         let exists = false;
         try {
            await queryInterface.describeTable('segment');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('segment', {
               ID: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
               domain: { type: DataTypes.STRING, allowNull: false },
               owner_id: { type: DataTypes.INTEGER, allowNull: true },
               name: { type: DataTypes.STRING, allowNull: false },
               filters: { type: DataTypes.TEXT, allowNull: false },
               created: { type: DataTypes.STRING, allowNull: false },
            }, { transaction: t });
            // Scope/lookup indexes.
            await queryInterface.addIndex('segment', ['domain'], { transaction: t });
            await queryInterface.addIndex('segment', ['owner_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('segment');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('segment', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
