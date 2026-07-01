// Migration: Adds the nullable owner_id column to the domain table.
// owner_id is the multi-tenant ownership column. It is nullable with no default: a
// NULL owner_id means "the original single-tenant admin." Existing rows get NULL and
// keep working exactly as today. No backfill is needed because the scoping helper
// treats NULL owner_id and owner_id = 1 (the seeded admin account) as equivalent.
// FKs are logical, not database-enforced, in wave 1 (SQLite cannot add a constraint to
// an existing table without a rebuild); a plain indexed INTEGER points at account.ID
// by convention.
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
         if (!domainTableDefinition.owner_id) {
            await queryInterface.addColumn('domain', 'owner_id', {
               type: DataTypes.INTEGER,
               allowNull: true,
            }, { transaction: t });

            await queryInterface.addIndex('domain', ['owner_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const domainTableDefinition = await queryInterface.describeTable('domain');
            if (domainTableDefinition && domainTableDefinition.owner_id) {
               await queryInterface.removeColumn('domain', 'owner_id', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
