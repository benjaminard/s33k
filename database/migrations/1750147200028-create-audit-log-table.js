// Migration: Creates the `audit_log` table (the privileged-access audit trail).
//
// WHY: with MULTI_TENANT on, the operator is a scoped tenant for its OWN data (utils/scope.ts) but
// keeps INSTANCE-admin powers (list accounts, mint/revoke keys, read the waitlist, run the cron
// keyword sweep). This table records those PRIVILEGED ACCESS events (metadata only, never tenant
// content, never secrets) so there is an honest, queryable answer to "what can the operator do and
// is it logged?". utils/auditLog.recordAudit is the single best-effort writer; it is a no-op with the
// flag off, so the table stays empty on a single-tenant install and that path is byte-for-byte unchanged.
//
// Column names/types BYTE-MATCH database/models/auditLog.ts (Postgres is case-sensitive): the PK is
// the lowercase "id" (autoincrement), and the free-text columns are TEXT (never STRING/VARCHAR(255))
// to avoid the prod-Postgres truncation class (CLAUDE.md A). timestamps:true on the model adds the
// sequelize createdAt/updatedAt columns, which sync creates; this migration creates the core columns
// and lets the on-boot sync add the timestamp columns (matching how other timestamped tables here are
// shaped). createdAt is the access time.
//
// FAIL-LOUD + IDEMPOTENT, dual-convention. The describeTable idempotency probe is the only swallowing
// try/catch (a missing table throws there = "not yet created"). createTable is UNWRAPPED so a real
// failure throws out of up() and stays retryable (entrypoint.sh exits non-zero on a migrate failure).

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         let exists = false;
         try {
            await queryInterface.describeTable('audit_log');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('audit_log', {
               id: {
                  type: DataTypes.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true,
               },
               actor_account_id: { type: DataTypes.INTEGER, allowNull: true },
               actor_role: { type: DataTypes.TEXT, allowNull: true },
               action: { type: DataTypes.TEXT, allowNull: false },
               target_account_id: { type: DataTypes.INTEGER, allowNull: true },
               target_domain: { type: DataTypes.TEXT, allowNull: true },
               route: { type: DataTypes.TEXT, allowNull: true },
               detail: { type: DataTypes.TEXT, allowNull: true },
               createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
               updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            }, { transaction: t });
            // An index on the action verb + actor for the operator's audit-trail reads. Idempotent by
            // virtue of running only inside the just-created-table branch.
            await queryInterface.addIndex('audit_log', ['action'], {
               name: 'audit_log_action',
               transaction: t,
            });
            await queryInterface.addIndex('audit_log', ['actor_account_id'], {
               name: 'audit_log_actor',
               transaction: t,
            });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('audit_log');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('audit_log', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
