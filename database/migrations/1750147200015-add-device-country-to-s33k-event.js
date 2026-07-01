// Migration: Adds the `device` and `country` columns to s33k_event.
//
// device is a coarse class ('mobile' | 'tablet' | 'desktop' | '') derived from the User-Agent at
// ingest; country is an ISO code from a geo header (cf-ipcountry / x-vercel-ip-country / etc.) or
// '' where the host provides none. Both are non-identifying segments (not a fingerprint, never the
// IP) that power the device and geography analytics filters. Existing rows default to '' (unknown).
//
// Dual-convention + idempotent, same pattern as the sibling event-column migrations. Safe on
// Postgres (prod) and SQLite (local) and safe to re-run.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

const COLUMNS = [
   ['device', { type: DataTypes.STRING, allowNull: true, defaultValue: '' }],
   ['country', { type: DataTypes.STRING, allowNull: true, defaultValue: '' }],
];

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY: a missing s33k_event table throws here and is caught so
         // the migration no-ops (the event table is created by an earlier migration). The
         // addColumn/addIndex path below is intentionally NOT wrapped: a real failure must
         // throw out of up() so Umzug leaves this migration un-applied and retryable. A
         // swallowed error would mark it APPLIED with the columns missing, and every read
         // expecting device/country would then throw forever with nothing to re-run.
         let tableDefinition = null;
         try {
            tableDefinition = await queryInterface.describeTable('s33k_event');
         } catch (describeError) {
            tableDefinition = null;
         }
         if (!tableDefinition) { return; }
         for (const [column, spec] of COLUMNS) {
            if (!tableDefinition[column]) {
               // eslint-disable-next-line no-await-in-loop
               await queryInterface.addColumn('s33k_event', column, spec, { transaction: t });
               // eslint-disable-next-line no-await-in-loop
               await queryInterface.addIndex('s33k_event', [column], { transaction: t });
            }
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
            if (!tableDefinition) { return; }
            for (const [column] of COLUMNS) {
               if (tableDefinition[column]) {
                  // eslint-disable-next-line no-await-in-loop
                  await queryInterface.removeColumn('s33k_event', column, { transaction: t });
               }
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
