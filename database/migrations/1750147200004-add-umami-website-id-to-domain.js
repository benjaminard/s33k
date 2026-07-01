// Migration: Adds the nullable umami_website_id column to the domain table.
// umami_website_id is the per-domain Umami analytics website id. For multi-tenant
// hosting, each customer domain needs its OWN Umami website (rather than the single
// fixed UMAMI_WEBSITE_ID env that today points at example.com). This column stores
// the provisioned Umami website id per domain. It is nullable with no default: a NULL
// umami_website_id means "fall back to the UMAMI_WEBSITE_ID env", so example.com and
// any existing row keep working exactly as today with no backfill. The onboard flow
// provisions a website and stamps its id here.
//
// This file supports both the Umzug v3 calling convention used by the app at
// /api/dbmigrate (the migration function is called with a single { context } object,
// where context is the Sequelize QueryInterface) and the classic sequelize-cli
// convention (the function is called with positional (queryInterface, Sequelize)). We
// normalise both into a queryInterface plus a DataTypes reference.

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
         // Idempotency probe ONLY: a missing domain table throws here and is caught so the migration
         // no-ops (an earlier migration owns the domain table). Everything below is deliberately
         // UNWRAPPED so a real failure throws and the migration stays un-applied and retryable.
         let domainTableDefinition = null;
         try {
            domainTableDefinition = await queryInterface.describeTable('domain');
         } catch (describeError) {
            domainTableDefinition = null;
         }
         if (!domainTableDefinition) { return; }
         if (!domainTableDefinition.umami_website_id) {
            await queryInterface.addColumn('domain', 'umami_website_id', {
               type: DataTypes.STRING,
               allowNull: true,
            }, { transaction: t });

            await queryInterface.addIndex('domain', ['umami_website_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const domainTableDefinition = await queryInterface.describeTable('domain');
            if (domainTableDefinition && domainTableDefinition.umami_website_id) {
               await queryInterface.removeColumn('domain', 'umami_website_id', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
