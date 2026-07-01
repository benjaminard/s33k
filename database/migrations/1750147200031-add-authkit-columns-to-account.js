// Migration: Adds the WorkOS AuthKit OAuth linkage columns to the account table.
//
//   workos_user_id     -> the `sub` of a verified AuthKit access token this account is linked to. The
//                         initial join is by verified email (email_hash); thereafter the MCP OAuth path
//                         resolves the account by this stable id. Carries a UNIQUE index so one WorkOS
//                         identity can never silently map to two accounts (many NULLs permitted, like
//                         the email_hash unique index).
//   mcp_oauth_key_enc  -> a per-account s33k API key minted for the OAuth-MCP path, stored cryptr-
//                         encrypted at rest (keyed by SECRET). The route decrypts it to bind the
//                         per-request fetchImpl, so authorize()/scoping is unchanged.
//
// ADDITIVE + NULLABLE by design. The seeded admin (ID = 1) and every existing account stay untouched
// (both columns null, the unique index permits many NULLs on Postgres and SQLite). Zero backfill.
//
// FAIL-LOUD by design (this is auth-path schema, same class as the email + scoped_domain auth columns):
// we guard ONLY idempotency (a re-run is a clean no-op once the column / index exists) and let a REAL
// addColumn / addIndex failure THROW, so a broken migration cannot silently leave an auth column or its
// uniqueness missing. We do NOT use the swallow-and-continue pattern.
//
// Supports both the Umzug v3 calling convention used by /api/dbmigrate (a single { context } object
// whose context is the Sequelize QueryInterface) and the classic sequelize-cli convention
// (positional (queryInterface, Sequelize)).

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// Explicit index name so the idempotency check and the down-migration find it deterministically across
// Postgres and SQLite (auto-generated names differ between engines).
const WORKOS_INDEX_NAME = 'account_workos_user_id_unique';

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const def = await queryInterface.describeTable('account');
         // Idempotency guards ONLY: add a column only if absent. A real addColumn failure THROWS.
         if (def && !def.workos_user_id) {
            await queryInterface.addColumn('account', 'workos_user_id', {
               type: DataTypes.TEXT,
               allowNull: true,
            }, { transaction: t });
         }
         if (def && !def.mcp_oauth_key_enc) {
            await queryInterface.addColumn('account', 'mcp_oauth_key_enc', {
               type: DataTypes.TEXT,
               allowNull: true,
            }, { transaction: t });
         }
         // Unique index on workos_user_id (permits many NULLs). showIndex makes the add idempotent; a
         // genuine addIndex failure is left to THROW (fail-loud).
         const indexes = await queryInterface.showIndex('account', { transaction: t });
         const exists = Array.isArray(indexes) && indexes.some((ix) => ix && ix.name === WORKOS_INDEX_NAME);
         if (!exists) {
            await queryInterface.addIndex('account', ['workos_user_id'], {
               unique: true,
               name: WORKOS_INDEX_NAME,
               transaction: t,
            });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const def = await queryInterface.describeTable('account');
         const indexes = await queryInterface.showIndex('account', { transaction: t });
         const exists = Array.isArray(indexes) && indexes.some((ix) => ix && ix.name === WORKOS_INDEX_NAME);
         if (exists) {
            await queryInterface.removeIndex('account', WORKOS_INDEX_NAME, { transaction: t });
         }
         if (def && def.mcp_oauth_key_enc) {
            await queryInterface.removeColumn('account', 'mcp_oauth_key_enc', { transaction: t });
         }
         if (def && def.workos_user_id) {
            await queryInterface.removeColumn('account', 'workos_user_id', { transaction: t });
         }
      });
   },
};
