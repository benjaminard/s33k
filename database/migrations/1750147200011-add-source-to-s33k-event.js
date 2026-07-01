// Migration: Adds the nullable `source` column to the s33k_event table.
//
// `source` is the session's first-touch SOURCE: a classification ('direct', 'referral',
// 'organic-search', 'ai') or at most the bare referrer host. It is NEVER a full referrer URL
// with a path or query (those can carry PII); the /api/collect ingest enforces that via
// sanitizeSource. The column powers conversion-by-source attribution (which traffic sources
// actually drive form submissions and other conversions) without any GA4-style setup.
//
// Existing rows get NULL source (no backfill: the referrer of a past session is gone, and the
// read surface treats a missing source as 'direct').
//
// This file supports both the Umzug v3 calling convention used by the app at /api/dbmigrate
// (the migration function is called with a single { context } object, where context is the
// Sequelize QueryInterface) and the classic sequelize-cli convention (positional
// (queryInterface, Sequelize)). We normalise both into a queryInterface. The whole thing is
// idempotent: it only adds the column (and its index) when absent, so it is safe on Postgres
// (prod) and SQLite (local) and safe to re-run.

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
         // Idempotent: the table may not exist yet on a brand-new DB built straight from
         // models; only touch it when it is present and the column is absent.
         let tableDefinition = null;
         try {
            tableDefinition = await queryInterface.describeTable('s33k_event');
         } catch (describeError) {
            tableDefinition = null;
         }
         if (tableDefinition && !tableDefinition.source) {
            await queryInterface.addColumn('s33k_event', 'source', {
               type: DataTypes.STRING,
               allowNull: true,
               defaultValue: null,
            }, { transaction: t });
            // Index source so conversion-by-source grouping stays cheap.
            await queryInterface.addIndex('s33k_event', ['source'], { transaction: t });
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
            if (tableDefinition && tableDefinition.source) {
               await queryInterface.removeColumn('s33k_event', 'source', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
