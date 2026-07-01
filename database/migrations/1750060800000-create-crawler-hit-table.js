// Migration: Creates the crawler_hit table.
// crawler_hit records one row per detected AI/search crawler request: the domain
// crawled, the bot and its owner, whether the bot is an AI answer engine, the
// path, the raw user-agent, and when the hit happened. This is the storage behind
// the flagship AI-crawler-detection signal (which AI answer-engine bots crawl the
// site, the leading indicator of AEO). Only crawler requests are recorded; normal
// browser traffic is classified and ignored at ingest time.
//
// This file supports both the Umzug v3 calling convention used by the app at
// /api/dbmigrate (the migration function is called with a single { context }
// object, where context is the Sequelize QueryInterface) and the classic
// sequelize-cli convention (the function is called with positional
// (queryInterface, Sequelize)). We normalise both into a queryInterface plus a
// DataTypes reference.

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
            await queryInterface.describeTable('crawler_hit');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('crawler_hit', {
               id: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
                  primaryKey: true,
                  autoIncrement: true,
               },
               domain: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               bot: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               owner: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               isAiEngine: {
                  type: DataTypes.BOOLEAN,
                  allowNull: false,
                  defaultValue: false,
               },
               path: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               userAgent: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               hitAt: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
            }, { transaction: t });

            // Index the lookup columns the ai-crawlers report filters and sorts on.
            await queryInterface.addIndex('crawler_hit', ['domain'], { transaction: t });
            await queryInterface.addIndex('crawler_hit', ['hitAt'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('crawler_hit');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('crawler_hit', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
