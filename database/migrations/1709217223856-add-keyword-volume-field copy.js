// Migration: Adds volume field to the keyword table.

// CLI Migration
module.exports = {
   up: async (queryInterface, Sequelize) => {
      return queryInterface.sequelize.transaction(async (t) => {
         let keywordTableDefinition = null;
         try { keywordTableDefinition = await queryInterface.describeTable('keyword'); } catch (describeError) { keywordTableDefinition = null; }
         if (!keywordTableDefinition) { return; }
         if (!keywordTableDefinition.volume) {
            await queryInterface.addColumn('keyword', 'volume', {
                type: Sequelize.DataTypes.STRING, allowNull: false, defaultValue: 0,
            }, { transaction: t });
         }
      });
   },
   down: (queryInterface) => {
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            const keywordTableDefinition = await queryInterface.describeTable('keyword');
            if (keywordTableDefinition) {
               if (keywordTableDefinition.volume) {
                  await queryInterface.removeColumn('keyword', 'volume', { transaction: t });
               }
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
