// Migration: Adds the nullable owner_id column to the keyword table.
// owner_id is the multi-tenant ownership column, denormalized onto keyword to match the
// fork's existing "join by domain string, no real FK" pattern so keyword queries can
// scope without a join. It is nullable with no default: a NULL owner_id means "the
// original single-tenant admin." Existing rows get NULL and keep working exactly as
// today. No backfill is needed because the scoping helper treats NULL owner_id and
// owner_id = 1 (the seeded admin account) as equivalent. FKs are logical, not
// database-enforced, in wave 1; a plain indexed INTEGER points at account.ID by
// convention.
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
         // Idempotency probe ONLY: a missing keyword table throws here and is caught so the migration
         // no-ops (an earlier migration owns the keyword table). Everything below is deliberately
         // UNWRAPPED so a real failure throws and the migration stays un-applied and retryable.
         let keywordTableDefinition = null;
         try {
            keywordTableDefinition = await queryInterface.describeTable('keyword');
         } catch (describeError) {
            keywordTableDefinition = null;
         }
         if (!keywordTableDefinition) { return; }
         if (!keywordTableDefinition.owner_id) {
            await queryInterface.addColumn('keyword', 'owner_id', {
               type: DataTypes.INTEGER,
               allowNull: true,
            }, { transaction: t });

            await queryInterface.addIndex('keyword', ['owner_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const keywordTableDefinition = await queryInterface.describeTable('keyword');
            if (keywordTableDefinition && keywordTableDefinition.owner_id) {
               await queryInterface.removeColumn('keyword', 'owner_id', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
