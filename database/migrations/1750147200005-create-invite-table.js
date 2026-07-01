// Migration: Creates the invite table.
// invite is the credential that lets someone into the invite-only, multi-tenant version of
// s33k. type 'external' brings a new admin + account (limited per inviter by the inviter
// account's external_invite_quota); type 'internal' adds a read-only member to an existing
// account (target_account_id). The `code` is the secret the public accept endpoint validates
// to mint a real API key, so it is long, random, single-use (status flips off 'pending' on
// acceptance), and indexed-unique for fast lookup + fast rejection of invalid codes.
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
         // Idempotent: only create the table if it does not already exist.
         let exists = false;
         try {
            await queryInterface.describeTable('invite');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('invite', {
               ID: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
                  primaryKey: true,
                  autoIncrement: true,
               },
               code: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               inviter_account_id: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
               },
               type: {
                  type: DataTypes.STRING,
                  allowNull: false,
                  defaultValue: 'external',
               },
               email: {
                  type: DataTypes.STRING,
                  allowNull: true,
               },
               target_account_id: {
                  type: DataTypes.INTEGER,
                  allowNull: true,
               },
               status: {
                  type: DataTypes.STRING,
                  allowNull: false,
                  defaultValue: 'pending',
               },
               accepted_at: {
                  type: DataTypes.DATE,
                  allowNull: true,
               },
               accepted_by_account_id: {
                  type: DataTypes.INTEGER,
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

            // The code is looked up directly and must be unguessable + single-use; index
            // it unique. Also index the columns the listing + quota counting filter on.
            await queryInterface.addIndex('invite', ['code'], { unique: true, transaction: t });
            await queryInterface.addIndex('invite', ['inviter_account_id'], { transaction: t });
            await queryInterface.addIndex('invite', ['target_account_id'], { transaction: t });
            await queryInterface.addIndex('invite', ['status'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('invite');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('invite', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
