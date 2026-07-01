// Migration: Adds the role column to the api_key table.
// role is 'admin' (full access: the account owner and all legacy keys) or 'member'
// (read-only seat, minted by an internal invite). A member key may only make GET requests;
// writes are rejected by authorize(). It is nullable with a default of 'admin' so every
// existing key keeps full access with zero backfill. Additive and idempotent. Only
// meaningful with MULTI_TENANT on (members only exist there).
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
         let apiKeyTableDefinition = null;
         try {
            apiKeyTableDefinition = await queryInterface.describeTable('api_key');
         } catch (describeError) {
            apiKeyTableDefinition = null;
         }
         if (!apiKeyTableDefinition) { return; }
         if (!apiKeyTableDefinition.role) {
            await queryInterface.addColumn('api_key', 'role', {
               type: DataTypes.STRING,
               allowNull: true,
               defaultValue: 'admin',
            }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const apiKeyTableDefinition = await queryInterface.describeTable('api_key');
            if (apiKeyTableDefinition && apiKeyTableDefinition.role) {
               await queryInterface.removeColumn('api_key', 'role', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
