// Migration: Adds the external_invite_quota column to the account table.
// external_invite_quota bounds how many EXTERNAL invites (each bringing a new admin +
// account into s33k) an account may send. It is nullable with a default of 5: existing
// rows take the default, new rows get 5, and the invite endpoint enforces the cap by
// counting this account's external invites against the quota. Additive and idempotent;
// no backfill needed.
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
         let accountTableDefinition = null;
         try {
            accountTableDefinition = await queryInterface.describeTable('account');
         } catch (describeError) {
            accountTableDefinition = null;
         }
         if (!accountTableDefinition) { return; }
         if (!accountTableDefinition.external_invite_quota) {
            await queryInterface.addColumn('account', 'external_invite_quota', {
               type: DataTypes.INTEGER,
               allowNull: true,
               defaultValue: 5,
            }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const accountTableDefinition = await queryInterface.describeTable('account');
            if (accountTableDefinition && accountTableDefinition.external_invite_quota) {
               await queryInterface.removeColumn('account', 'external_invite_quota', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
