// Migration: Adds the scoped_domain column to the api_key table.
//
// scoped_domain marks a SHARE key: a read-only key minted on a domain owner's account but
// RESTRICTED to one domain (the value stored here). A normal key has it null. authorize()
// enforces the restriction centrally: a key with scoped_domain set is denied any non-GET and
// any request whose `domain` query param does not exactly equal this value. Because the key
// lives on the owner's account, scopeWhere(owner) and every pillar query work unchanged.
//
// It is nullable so every existing key keeps null and is unaffected: additive, zero backfill.
// The column is TEXT (not the default VARCHAR(255)) to match the prod-Postgres
// widen-string-columns-to-text convention and to byte-match the model's DataType.TEXT.
//
// FAIL-LOUD by design (this is security-critical auth schema): we guard ONLY idempotency (a
// re-run is a clean no-op once the column exists) and let a REAL addColumn failure THROW, so a
// broken migration cannot silently leave the column missing and let share enforcement degrade.
// This differs from the older additive migrations that swallow errors; that swallowing is
// exactly the failure mode this column must not have.
//
// Supports both the Umzug v3 calling convention used by /api/dbmigrate (a single { context }
// object whose context is the Sequelize QueryInterface) and the classic sequelize-cli
// convention (positional (queryInterface, Sequelize)).

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
         const apiKeyTableDefinition = await queryInterface.describeTable('api_key');
         // Idempotency guard ONLY: skip if the column already exists. Any other error (a real
         // failure to add the column) is intentionally NOT caught, so it surfaces loudly.
         if (apiKeyTableDefinition && !apiKeyTableDefinition.scoped_domain) {
            await queryInterface.addColumn('api_key', 'scoped_domain', {
               type: DataTypes.TEXT,
               allowNull: true,
            }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const apiKeyTableDefinition = await queryInterface.describeTable('api_key');
         if (apiKeyTableDefinition && apiKeyTableDefinition.scoped_domain) {
            await queryInterface.removeColumn('api_key', 'scoped_domain', { transaction: t });
         }
      });
   },
};
