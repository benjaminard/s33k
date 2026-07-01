// Migration: Creates the feature_request table.
//
// feature_request stores one row per request, captured over MCP, for a capability s33k does
// NOT yet have. It is the storage behind request_feature: a user's LLM, after confirming via
// the help/knowledge layer that the capability does not already exist, submits the ask here so
// an admin can review it. account_id is the requesting account; owner_id mirrors it for tenant
// scoping parity (NULL == the legacy single-tenant admin account). status is the triage state
// ('open' | 'reviewed' | 'planned' | 'declined' | 'shipped'); matched_capability is null for
// stored (unmatched) requests and exists for later human annotation. request/context are TEXT
// because a request is free-form prose.
//
// This file supports both the Umzug v3 calling convention used by the app at /api/dbmigrate
// (the migration function is called with a single { context } object, where context is the
// Sequelize QueryInterface) and the classic sequelize-cli convention (positional
// (queryInterface, Sequelize)). We normalise both into a queryInterface plus a DataTypes
// reference. The whole thing is idempotent: it only creates the table when it is absent.

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
         // Idempotent: only create the table if it does not already exist.
         let exists = false;
         try {
            await queryInterface.describeTable('feature_request');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('feature_request', {
               ID: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
                  primaryKey: true,
                  autoIncrement: true,
               },
               account_id: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
               },
               owner_id: {
                  type: DataTypes.INTEGER,
                  allowNull: true,
               },
               request: {
                  type: DataTypes.TEXT,
                  allowNull: false,
               },
               context: {
                  type: DataTypes.TEXT,
                  allowNull: true,
               },
               status: {
                  type: DataTypes.STRING,
                  allowNull: false,
                  defaultValue: 'open',
               },
               matched_capability: {
                  type: DataTypes.STRING,
                  allowNull: true,
               },
               createdAt: {
                  type: DataTypes.DATE,
                  allowNull: true,
               },
               updatedAt: {
                  type: DataTypes.DATE,
                  allowNull: true,
               },
            }, { transaction: t });

            // Index the columns the read surface scopes and filters/sorts on.
            await queryInterface.addIndex('feature_request', ['account_id'], { transaction: t });
            await queryInterface.addIndex('feature_request', ['owner_id'], { transaction: t });
            await queryInterface.addIndex('feature_request', ['status'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('feature_request');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('feature_request', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
