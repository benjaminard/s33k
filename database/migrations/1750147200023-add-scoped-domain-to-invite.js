// Migration: Adds the scoped_domain column to the invite table.
//
// scoped_domain marks a SHARE invite: a one-time activation link that, when accepted, mints a
// read-only key RESTRICTED to one domain (the value stored here) on the invite's
// target_account_id (the domain owner's account). A normal invite (external / internal) has it
// null. The share email therefore carries NO key: the scoped key is minted only on accept and
// shown once, the safer replacement for embedding the key inline in the email.
//
// It is nullable so every existing invite keeps null and is unaffected: additive, zero backfill.
// The column is TEXT (not the default VARCHAR(255)) to match the prod-Postgres
// widen-string-columns-to-text convention and to byte-match the model's DataType.TEXT.
//
// FAIL-LOUD by design (this is security-critical invite/auth schema): we guard ONLY idempotency
// (a re-run is a clean no-op once the column exists) and let a REAL addColumn failure THROW, so a
// broken migration cannot silently leave the column missing and let a share invite mint an
// UNSCOPED key. This mirrors the add-scoped-domain-to-api-key migration and differs from the
// older additive migrations that swallow errors; that swallowing is exactly the failure mode a
// scoping column must not have.
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
         const inviteTableDefinition = await queryInterface.describeTable('invite');
         // Idempotency guard ONLY: skip if the column already exists. Any other error (a real
         // failure to add the column) is intentionally NOT caught, so it surfaces loudly.
         if (inviteTableDefinition && !inviteTableDefinition.scoped_domain) {
            await queryInterface.addColumn('invite', 'scoped_domain', {
               type: DataTypes.TEXT,
               allowNull: true,
            }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const inviteTableDefinition = await queryInterface.describeTable('invite');
         if (inviteTableDefinition && inviteTableDefinition.scoped_domain) {
            await queryInterface.removeColumn('invite', 'scoped_domain', { transaction: t });
         }
      });
   },
};
