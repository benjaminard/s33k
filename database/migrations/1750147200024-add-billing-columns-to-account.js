// Migration: Adds the Stripe-billing columns to the account table.
//
//   stripe_customer_id   (TEXT, null)     - Stripe customer id (cus_...), set on first Checkout.
//   subscription_status  (TEXT, null)     - 'trialing'|'active'|'past_due'|'canceled'|'incomplete'.
//   trial_ends_at        (DATE, null)     - end of the 14-day no-credit-card trial.
//   current_period_end   (DATE, null)     - end of the current paid Stripe billing period.
//   paid_sites           (INTEGER, null)  - the Stripe subscription QUANTITY = number of sites
//                                           purchased ($7 each, 50 keywords each). resolveCaps caps
//                                           the account at 50 * paid_sites keywords and paid_sites
//                                           domains. Null while trialing / never-subscribed.
//
// The per-unit model has NO named tiers, so no plan column is added: the legacy `plan` column on
// account is left in place but UNUSED by billing. Caps come from paid_sites, not from a plan.
//
// All columns are nullable: every existing row keeps null and is unaffected. Additive, zero
// backfill. Only meaningful with MULTI_TENANT on; inert (admin always active) with the flag off.
//
// FAIL-LOUD by design (this is COGS/paywall-critical schema, same class as the scoped_domain
// auth column): we guard ONLY idempotency (a re-run is a clean no-op once a column exists) and
// let a REAL addColumn failure THROW, so a broken migration cannot silently leave a column
// missing and let trial/cap gating read undefined. This differs from the older additive
// migrations that swallow errors; that swallowing is exactly the failure mode billing must avoid.
//
// Supports both the Umzug v3 calling convention used by /api/dbmigrate (a single { context }
// object whose context is the Sequelize QueryInterface) and the classic sequelize-cli convention
// (positional (queryInterface, Sequelize)).

const { DataTypes } = require('sequelize');

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

// The columns to add, each keyed by the EXACT column name the model maps to (byte-match).
const COLUMNS = [
   { name: 'stripe_customer_id', spec: { type: DataTypes.TEXT, allowNull: true } },
   { name: 'subscription_status', spec: { type: DataTypes.TEXT, allowNull: true } },
   { name: 'trial_ends_at', spec: { type: DataTypes.DATE, allowNull: true } },
   { name: 'current_period_end', spec: { type: DataTypes.DATE, allowNull: true } },
   { name: 'paid_sites', spec: { type: DataTypes.INTEGER, allowNull: true } },
];

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const accountTableDefinition = await queryInterface.describeTable('account');
         for (const { name, spec } of COLUMNS) {
            // Idempotency guard ONLY: skip a column that already exists. Any other error (a real
            // failure to add it) is intentionally NOT caught, so it surfaces loudly.
            if (accountTableDefinition && !accountTableDefinition[name]) {
               // eslint-disable-next-line no-await-in-loop
               await queryInterface.addColumn('account', name, spec, { transaction: t });
            }
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         const accountTableDefinition = await queryInterface.describeTable('account');
         for (const { name } of COLUMNS) {
            if (accountTableDefinition && accountTableDefinition[name]) {
               // eslint-disable-next-line no-await-in-loop
               await queryInterface.removeColumn('account', name, { transaction: t });
            }
         }
      });
   },
};
