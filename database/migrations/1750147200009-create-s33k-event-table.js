// Migration: Creates the s33k_event table.
//
// s33k_event records one row per autocaptured engagement event sent by the s33k.js client
// script on a customer site: the domain, the owning account (owner_id, stamped at ingest so
// reads are tenant-scoped), the event type (click, form_submit, scroll, engagement,
// outbound), the page path, a sanitized label (element text / form name / outbound host),
// an optional CSS selector, an optional numeric value (scroll percent or engagement
// seconds), a cookieless anonymous session id, and when it happened.
//
// PRIVACY: this table never stores the contents of any input/textarea/select/contenteditable
// or any value a person typed. It stores THAT an interaction happened, not what was entered.
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
            await queryInterface.describeTable('s33k_event');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('s33k_event', {
               id: {
                  type: DataTypes.BIGINT,
                  allowNull: false,
                  primaryKey: true,
                  autoIncrement: true,
               },
               domain: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               owner_id: {
                  type: DataTypes.INTEGER,
                  allowNull: true,
               },
               type: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               page: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               label: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               selector: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               value: {
                  type: DataTypes.INTEGER,
                  allowNull: true,
               },
               session: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               created: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
            }, { transaction: t });

            // Index the columns the read surfaces filter, scope, and sort on.
            await queryInterface.addIndex('s33k_event', ['domain'], { transaction: t });
            await queryInterface.addIndex('s33k_event', ['owner_id'], { transaction: t });
            await queryInterface.addIndex('s33k_event', ['created'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('s33k_event');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('s33k_event', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
