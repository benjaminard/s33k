// Migration: Adds the target_page field to the keyword table.
// This replaces the earlier hack where a keyword's target page was stuffed into
// the keyword's tags array. The migration also performs a light backfill: for any
// existing keyword whose tags contain a single path-like value (a value that starts
// with a forward slash), that value is copied into the new target_page column so
// existing keywords keep their target page after the upgrade.
//
// This file supports both the Umzug v3 calling convention used by the app at
// /api/dbmigrate (the migration function is called with a single { context } object,
// where context is the Sequelize QueryInterface) and the classic sequelize-cli
// convention (the function is called with positional (queryInterface, Sequelize)).
// We normalise both into a queryInterface plus a DataTypes reference.

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
         // Idempotent: the keyword table may not exist yet on a brand-new DB built straight from
         // models; only touch it when it is present and the column is absent.
         let keywordTableDefinition = null;
         try {
            keywordTableDefinition = await queryInterface.describeTable('keyword');
         } catch (describeError) {
            keywordTableDefinition = null;
         }
         if (!keywordTableDefinition) { return; }
         if (!keywordTableDefinition.target_page) {
            await queryInterface.addColumn('keyword', 'target_page', {
               type: DataTypes.STRING,
               allowNull: true,
               defaultValue: '',
            }, { transaction: t });

            // Light backfill: copy a path-like tag into target_page for existing rows.
            // "ID" is quoted: Postgres folds unquoted identifiers to lowercase, but the column
            // was created quoted ("ID"), so unquoted ID would fail to resolve on Postgres.
            const [rows] = await queryInterface.sequelize.query(
               'SELECT "ID", tags FROM keyword',
               { transaction: t },
            );
            for (const row of rows) {
               let parsedTags = [];
               try {
                  parsedTags = row.tags ? JSON.parse(row.tags) : [];
               } catch (parseError) {
                  parsedTags = [];
               }
               const pathTag = Array.isArray(parsedTags)
                  ? parsedTags.find((tag) => typeof tag === 'string' && tag.trim().startsWith('/'))
                  : undefined;
               if (pathTag) {
                  await queryInterface.sequelize.query(
                     'UPDATE keyword SET target_page = :targetPage WHERE "ID" = :id',
                     { replacements: { targetPage: pathTag.trim(), id: row.ID }, transaction: t },
                  );
               }
            }
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const keywordTableDefinition = await queryInterface.describeTable('keyword');
            if (keywordTableDefinition && keywordTableDefinition.target_page) {
               await queryInterface.removeColumn('keyword', 'target_page', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
