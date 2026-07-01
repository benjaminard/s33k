// Migration: Adds the five nullable UTM / campaign columns to s33k_event.
//
// utm_source, utm_medium, utm_campaign, utm_term, utm_content are the standard campaign tagging
// params. The s33k.js client parses them from the landing page URL's querystring once per session
// and carries them on the batch; the /api/collect ingest sanitizes and length-caps them and stamps
// them on every event row. They power the campaign-attribution report (which campaign / medium /
// source actually drove traffic and conversions) without any GA4-style setup.
//
// PRIVACY: these are campaign labels, not PII. They are sanitized (control chars stripped,
// whitespace collapsed) and length-capped at ingest exactly like the other free-text string
// columns. Existing rows get NULL (no backfill: a past session's landing URL is gone, and the read
// surface treats a missing utm value as untagged / 'direct').
//
// Dual-convention + idempotent, same pattern as the sibling event-column migrations. Works on
// Postgres (prod) and SQLite (local) and is safe to re-run.
//
// FAIL-LOUD: the idempotency probe (describeTable) is the ONLY thing wrapped in a swallowing
// try/catch, because a missing s33k_event table on a brand-new DB must no-op. The addColumn/
// addIndex path is intentionally NOT wrapped: a real failure MUST throw out of up() so Umzug
// leaves this migration un-applied and retryable. A swallowed error would mark it APPLIED with the
// columns missing, and every campaign read would then throw forever with nothing to re-run.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// TEXT (not STRING/VARCHAR(255)): a campaign value is normally short, but a long tagged URL can
// produce a value past 255 chars, which silently overflows VARCHAR(255) on Postgres while passing
// on SQLite. TEXT keeps the dialects consistent (same lesson as the page/label/selector columns).
const COLUMNS = [
   ['utm_source', { type: DataTypes.TEXT, allowNull: true, defaultValue: null }],
   ['utm_medium', { type: DataTypes.TEXT, allowNull: true, defaultValue: null }],
   ['utm_campaign', { type: DataTypes.TEXT, allowNull: true, defaultValue: null }],
   ['utm_term', { type: DataTypes.TEXT, allowNull: true, defaultValue: null }],
   ['utm_content', { type: DataTypes.TEXT, allowNull: true, defaultValue: null }],
];

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY: a missing s33k_event table throws here and is caught so the
         // migration no-ops (the event table is created by an earlier migration). Everything below
         // is deliberately UNWRAPPED so a real failure throws and the migration stays retryable.
         let tableDefinition = null;
         try {
            tableDefinition = await queryInterface.describeTable('s33k_event');
         } catch (describeError) {
            tableDefinition = null;
         }
         if (!tableDefinition) { return; }
         for (const [column, spec] of COLUMNS) {
            if (!tableDefinition[column]) {
               // eslint-disable-next-line no-await-in-loop
               await queryInterface.addColumn('s33k_event', column, spec, { transaction: t });
               // Index each UTM column so campaign grouping (GROUP BY utm_campaign etc.) stays cheap.
               // eslint-disable-next-line no-await-in-loop
               await queryInterface.addIndex('s33k_event', [column], { transaction: t });
            }
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let tableDefinition = null;
            try {
               tableDefinition = await queryInterface.describeTable('s33k_event');
            } catch (describeError) {
               tableDefinition = null;
            }
            if (!tableDefinition) { return; }
            for (const [column] of COLUMNS) {
               if (tableDefinition[column]) {
                  // eslint-disable-next-line no-await-in-loop
                  await queryInterface.removeColumn('s33k_event', column, { transaction: t });
               }
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
