// Migration: Creates the api_key table.
// api_key holds per-account Bearer keys for the hosted, multi-tenant version of s33k.
// One account can have many keys; a key maps to exactly one account. The full key is
// shown ONCE at creation and never stored in clear: only key_prefix (for lookup +
// display) and key_hash (SHA-256 of the full key) are persisted. Lookup is by the
// indexed key_prefix, then the hash is verified. The legacy global process.env.APIKEY
// is separate and is never stored here.
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
         // Idempotency probe ONLY: a missing table throws here, which is the expected
         // "not yet created" signal, so it is caught and treated as exists=false. The
         // create/addIndex path below is intentionally NOT wrapped: a real failure must
         // throw out of up() so Umzug leaves this migration un-applied and retryable.
         let exists = false;
         try {
            await queryInterface.describeTable('api_key');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('api_key', {
               ID: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
                  primaryKey: true,
                  autoIncrement: true,
               },
               account_id: {
                  type: DataTypes.INTEGER,
                  allowNull: false,
               },
               name: {
                  type: DataTypes.STRING,
                  allowNull: true,
                  defaultValue: '',
               },
               key_prefix: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               key_hash: {
                  type: DataTypes.STRING,
                  allowNull: false,
               },
               last_used_at: {
                  type: DataTypes.DATE,
                  allowNull: true,
               },
               revoked_at: {
                  type: DataTypes.DATE,
                  allowNull: true,
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

            // Index the lookup columns the resolver filters on.
            await queryInterface.addIndex('api_key', ['key_prefix'], { transaction: t });
            await queryInterface.addIndex('api_key', ['account_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('api_key');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('api_key', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
