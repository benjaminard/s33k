// Migration: Creates the waitlist table.
// waitlist holds anyone who wants into s33k but has no invite yet. The public waitlist
// endpoint writes rows here (deduped by email); an admin reads the list to decide who to
// send an external invite to. status flips from 'waiting' to 'invited' once an invite goes
// out. email is indexed-unique so the dedupe is enforced at the database level.
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
            await queryInterface.describeTable('waitlist');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('waitlist', {
               ID: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
                  primaryKey: true,
                  autoIncrement: true,
               },
               email: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               domain: {
                  type: DataTypes.STRING,
                  allowNull: true,
               },
               note: {
                  type: DataTypes.STRING,
                  allowNull: true,
               },
               status: {
                  type: DataTypes.STRING,
                  allowNull: false,
                  defaultValue: 'waiting',
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

            // Dedupe by email at the database level; index status for the admin listing.
            await queryInterface.addIndex('waitlist', ['email'], { unique: true, transaction: t });
            await queryInterface.addIndex('waitlist', ['status'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('waitlist');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('waitlist', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
