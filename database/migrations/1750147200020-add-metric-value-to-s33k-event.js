// Migration: Adds the nullable `metric_value` FLOAT column to s33k_event.
//
// metric_value holds the numeric value of a Core Web Vital field measurement (a real-user
// performance metric) captured by the s33k.js client and posted on a type:'webvital' event:
// LCP / FCP / TTFB / INP / FID in milliseconds, or CLS as a unitless layout-shift score. It is
// a FLOAT (not INTEGER): CLS is fractional, and the timing metrics carry sub-millisecond
// precision worth keeping for percentile aggregation. NULL for every non-webvital event type, so
// the existing click / form_submit / scroll / engagement / outbound / pageview rows are unchanged.
//
// FLOAT (never DataType.STRING): a metric value is a number, and STRING would be VARCHAR(255) on
// Postgres, the overflow class this repo has been bitten by twice. There is no length question
// for a numeric column.
//
// No index: web-vital reads filter by (type = 'webvital', label) first (both already cheap to
// scope) and then AGGREGATE metric_value (percentiles / averages over the already-narrow slice);
// they never look a row up BY metric_value, so an index on it would add write cost for no read
// win. Skipped on purpose per the "index lightly only if cheap, else skip" guidance.
//
// Existing rows get NULL (no backfill: a past page load's field metrics are gone, and the read
// surface only counts non-null metric_value rows of type 'webvital').
//
// Dual-convention (Umzug v3 { context } and classic positional) + idempotent, same pattern as the
// sibling event-column migrations. Works on Postgres (prod) and SQLite (local) and is safe to
// re-run.
//
// FAIL-LOUD: the idempotency probe (describeTable) is the ONLY thing wrapped in a swallowing
// try/catch, because a missing s33k_event table on a brand-new DB must no-op. The addColumn path
// is intentionally NOT wrapped: a real failure MUST throw out of up() so Umzug leaves this
// migration un-applied and retryable. A swallowed error would mark it APPLIED with the column
// missing, and every web-vital read/write would then break with nothing to re-run.

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         // Idempotency probe ONLY: a missing s33k_event table throws here and is caught so the
         // migration no-ops (the event table is created by an earlier migration). The addColumn
         // below is deliberately UNWRAPPED so a real failure throws and the migration stays retryable.
         let tableDefinition = null;
         try {
            tableDefinition = await queryInterface.describeTable('s33k_event');
         } catch (describeError) {
            tableDefinition = null;
         }
         if (!tableDefinition) { return; }
         if (!tableDefinition.metric_value) {
            await queryInterface.addColumn('s33k_event', 'metric_value', {
               type: DataTypes.FLOAT,
               allowNull: true,
               defaultValue: null,
            }, { transaction: t });
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
            if (tableDefinition.metric_value) {
               await queryInterface.removeColumn('s33k_event', 'metric_value', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
