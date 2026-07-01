// Migration: Creates the prompt_check table.
//
// prompt_check stores one row per tracked buyer PROMPT for a domain and its LATEST recorded
// AI-citation result (see database/models/promptCheck.ts). It is the storage half of prompt_radar:
// the join "are AI engines citing us for our buyer prompts, and do the cited pages convert".
//
// CRITICAL: s33k has NO server-side LLM. A row is created with NO result (engine/cited/position/
// cited_url/checked_at all NULL) and is populated ONLY when the user's own LLM records what IT found
// after querying an engine (the prompt-record route). The server never queries an AI engine. owner_id
// mirrors the owning domain for tenant scoping (NULL == the legacy single-tenant admin account).
//
// Column names/types BYTE-MATCH the model (Postgres is case-sensitive): the PK is "ID" (matching
// goal.ts), free text (domain/prompt/engine/cited_url) is TEXT (never STRING, which is VARCHAR(255)
// on Postgres and would truncate a URL), and created/checked_at are DATE.
//
// Dual-convention (Umzug v3 { context } and classic positional) + idempotent: only creates the table
// when absent. Safe on Postgres (prod) and SQLite (local) and safe to re-run.
//
// FAIL-LOUD: the idempotency probe (describeTable) is the ONLY thing wrapped in a swallowing
// try/catch, because a missing table throws there, which is the expected "not yet created" signal.
// The create/addIndex path is intentionally NOT wrapped: a real failure must throw out of up() so
// Umzug leaves this migration un-applied and retryable. entrypoint.sh runs db:migrate on boot and
// does NOT exit on failure, so a swallowed error would mark this APPLIED with no prompt_check table
// and every PromptCheck read/create would throw forever with nothing left to re-run.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY (see header). A missing table throws here and is caught as
         // exists=false. The createTable/addIndex below is deliberately UNWRAPPED so a real failure
         // throws and the migration stays retryable.
         let exists = false;
         try {
            await queryInterface.describeTable('prompt_check');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('prompt_check', {
               ID: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
               domain: { type: DataTypes.TEXT, allowNull: false },
               owner_id: { type: DataTypes.INTEGER, allowNull: true },
               prompt: { type: DataTypes.TEXT, allowNull: false },
               engine: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
               cited: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
               position: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
               cited_url: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
               checked_at: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
               created: { type: DataTypes.DATE, allowNull: false },
            }, { transaction: t });
            // Scope/lookup indexes: list by domain, and scope by (domain, owner) for the tenant gate.
            await queryInterface.addIndex('prompt_check', ['domain'], { transaction: t });
            await queryInterface.addIndex('prompt_check', ['domain', 'owner_id'], { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('prompt_check');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('prompt_check', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
