// Migration: Adds the `email` column to the account table, with a UNIQUE index.
//
// `email` is the lookup key for PASSWORDLESS magic-link login: a returning user POSTs their email
// to /api/auth/request-link, we look the account up by this column, and (if it exists) mail a
// one-time login link that mints a fresh API key. It is set on signup in invite/accept.ts
// (acceptExternal stamps it from invite.email), so every account created through the invite flow
// carries the email it was invited with.
//
// ADDITIVE + NULLABLE by design. The seeded admin account (ID = 1) has NO email and must keep
// working untouched, so the column is nullable. The UNIQUE index permits MANY NULLs on both
// Postgres and SQLite (SQL standard: NULLs are distinct), so the email-less admin row and any
// pre-migration rows are unaffected. Only a duplicate NON-NULL email is rejected, which is exactly
// the invariant magic-link login needs (an email resolves to at most one account). Zero backfill.
//
// FAIL-LOUD by design (this is auth-lookup schema, same class as the scoped_domain auth column and
// the billing columns): we guard ONLY idempotency (a re-run is a clean no-op once the column /
// index exists) and let a REAL addColumn / addIndex failure THROW, so a broken migration cannot
// silently leave the column or its uniqueness missing and let login degrade (a missing unique index
// would let two accounts share an email, making the by-email lookup ambiguous). This differs from
// the older additive migrations that swallow errors; that swallowing is exactly the failure mode
// auth schema must avoid.
//
// Supports both the Umzug v3 calling convention used by /api/dbmigrate (a single { context } object
// whose context is the Sequelize QueryInterface) and the classic sequelize-cli convention
// (positional (queryInterface, Sequelize)).

const { DataTypes } = require('sequelize');

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// The explicit index name so the idempotency check and the down-migration can find it
// deterministically across Postgres and SQLite (auto-generated names differ between engines).
const EMAIL_INDEX_NAME = 'account_email_unique';

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const accountTableDefinition = await queryInterface.describeTable('account');
         // Idempotency guard ONLY: add the column only if it is absent. Any other error (a real
         // failure to add it) is intentionally NOT caught, so it surfaces loudly.
         if (accountTableDefinition && !accountTableDefinition.email) {
            await queryInterface.addColumn('account', 'email', {
               type: DataTypes.STRING,
               allowNull: true,
            }, { transaction: t });
         }
         // Add the unique index idempotently. showIndex tells us whether it already exists, so a
         // re-run is a clean no-op; a genuine addIndex failure is left to THROW (fail-loud).
         const indexes = await queryInterface.showIndex('account', { transaction: t });
         const exists = Array.isArray(indexes) && indexes.some((ix) => ix && ix.name === EMAIL_INDEX_NAME);
         if (!exists) {
            await queryInterface.addIndex('account', ['email'], {
               unique: true,
               name: EMAIL_INDEX_NAME,
               transaction: t,
            });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const accountTableDefinition = await queryInterface.describeTable('account');
         const indexes = await queryInterface.showIndex('account', { transaction: t });
         const exists = Array.isArray(indexes) && indexes.some((ix) => ix && ix.name === EMAIL_INDEX_NAME);
         if (exists) {
            await queryInterface.removeIndex('account', EMAIL_INDEX_NAME, { transaction: t });
         }
         if (accountTableDefinition && accountTableDefinition.email) {
            await queryInterface.removeColumn('account', 'email', { transaction: t });
         }
      });
   },
};
