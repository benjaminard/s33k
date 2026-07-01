import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// Account is the billing/ownership unit for the hosted, multi-tenant version of s33k.
// In the common case one account == one company == one human, but the model allows
// many api keys (and later many users) per account.
//
// Seeded with exactly one admin row (ID = 1) which is the home for all legacy
// single-tenant data. A NULL owner_id on domain/keyword and owner_id = 1 are treated
// as equivalent by the scoping helper, so existing rows keep working with zero
// migration. This table only matters once MULTI_TENANT is turned on; with the flag
// off it is inert.
@Table({
  timestamps: true,
  tableName: 'account',
})

class Account extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   name!: string;

   // The email this account was invited with, ENCRYPTED AT REST. As of the encrypt-account-email
   // migration this column holds the cryptr-encrypted (AES-256, keyed by SECRET) ciphertext of the
   // address, NOT the plaintext: a DB dump no longer exposes login emails. It is decryptable to
   // display the address (utils/accountEmail.decryptEmail) but is NOT used for lookup or uniqueness,
   // because cryptr's random IV makes the ciphertext non-deterministic. The deterministic lookup +
   // uniqueness moved to email_hash below. TEXT (not STRING) so the ciphertext never truncates on
   // Postgres. Nullable: the seeded admin (no email) and any null-email account stay null. Set on
   // signup in invite/accept.ts (createAccount encrypts invite.email). Only meaningful with
   // MULTI_TENANT on (login routes hard-reject when the flag is off).
   @Column({ type: DataType.TEXT, allowNull: true })
   email!: string | null;

   // The deterministic blind index for the email: keyed HMAC-SHA256(SECRET, normalized email), hex
   // (utils/accountEmail.emailHash). This is the LOOKUP KEY for magic-link login + signup dedupe
   // (/api/auth/request-link and /api/signup query by this) and the column the UNIQUE index sits on,
   // so it enforces at-most-one account per non-null email while permitting many NULLs (null email ->
   // null hash). It is keyed by SECRET so a DB-dump attacker cannot brute-force the small email space
   // or build a rainbow table without also stealing SECRET. Nullable + TEXT, additive. Set wherever
   // email is set (createAccount). Only meaningful with MULTI_TENANT on.
   @Column({ type: DataType.TEXT, allowNull: true })
   email_hash!: string | null;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'free' })
   plan!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'active' })
   status!: string;

   // How many EXTERNAL invites this account may send (each external invite brings a new
   // admin + account into s33k). The viral lever, bounded so one account cannot flood the
   // system. Internal invites (read-only members on this account) are unlimited and not
   // counted against this. Only meaningful with MULTI_TENANT on.
   @Column({ type: DataType.INTEGER, allowNull: true, defaultValue: 5 })
   external_invite_quota!: number;

   // === Billing (per-unit Stripe subscription + 14-day no-credit-card trial) ===================
   // These billing columns are the per-account billing state. They are nullable + additive (zero
   // backfill), only meaningful with MULTI_TENANT on, and inert when the flag is off (the single
   // admin account is always treated as active and unlimited by isAccountActive / resolveCaps).
   // MODEL: per-unit, $7 per SITE / month, 50 keywords per site, weekly rank checks. The subscription
   // QUANTITY is the number of sites and is stored in `paid_sites` below. resolveCaps (utils/plans.ts)
   // derives caps from paid_sites; gating is driven by subscription_status + trial_ends_at. The
   // legacy `plan` column above is now UNUSED by billing (left in place, harmless): there are no
   // named tiers, so nothing reads or writes it for billing decisions.

   // The Stripe customer id (cus_...). Null until the account first runs Checkout (no card is
   // collected at trial start, so a trialing account has no Stripe customer yet). TEXT to match
   // the prod-Postgres widen-to-TEXT convention and avoid the VARCHAR(255) overflow class.
   @Column({ type: DataType.TEXT, allowNull: true })
   stripe_customer_id!: string | null;

   // The Stripe subscription lifecycle state: 'trialing' | 'active' | 'past_due' | 'canceled' |
   // 'incomplete'. Null for a never-subscribed account (e.g. the seeded admin / legacy data).
   // This is DISTINCT from the `status` column above, which is the account enable/disable gate
   // resolveAccount checks at auth time. subscription_status drives the trial + paywall gating.
   @Column({ type: DataType.TEXT, allowNull: true })
   subscription_status!: string | null;

   // When the 14-day no-CC trial ends. Set on signup (acceptExternal) to now + 14 days. Null for
   // accounts that never trialed. isAccountActive treats a trialing account as active only while
   // this is in the future. DATE (not TEXT) so comparisons are real timestamp comparisons.
   @Column({ type: DataType.DATE, allowNull: true })
   trial_ends_at!: Date | null;

   // The end of the current paid Stripe billing period (from the subscription object). Null until
   // a subscription exists. Informational for the billing-status view; gating uses
   // subscription_status, not this. DATE for the same reason as trial_ends_at.
   @Column({ type: DataType.DATE, allowNull: true })
   current_period_end!: Date | null;

   // The number of SITES this account has purchased = the Stripe subscription QUANTITY. Each site is
   // $7/mo and includes 50 keywords, so resolveCaps caps the account at 50 * paid_sites keywords and
   // paid_sites domains. Null until a subscription exists (a trialing account gets 1 site implicitly).
   // The webhook stamps this from subscription.items.data[0].quantity. INTEGER, nullable, additive.
   @Column({ type: DataType.INTEGER, allowNull: true })
   paid_sites!: number | null;

   // === WorkOS AuthKit OAuth linkage (lets normal Claude / ChatGPT connect over MCP) ============
   // The WorkOS user id (the `sub` of a verified AuthKit access token) this account is linked to, set
   // the first time the user connects the hosted MCP via AuthKit OAuth (utils/authkit). The INITIAL
   // join is by verified email (email_hash); thereafter we resolve by this stable id. Carries a UNIQUE
   // index (one account per WorkOS user, many NULLs permitted, exactly like email_hash), so a single
   // WorkOS identity can never silently map to two accounts. Nullable + TEXT, additive, only meaningful
   // with MULTI_TENANT on and AUTHKIT_DOMAIN set.
   @Column({ type: DataType.TEXT, allowNull: true })
   workos_user_id!: string | null;

   // A per-account s33k API key minted for the AuthKit-OAuth MCP path, stored cryptr-ENCRYPTED AT REST
   // (AES-256, keyed by SECRET), the SAME at-rest protection as `email`. Once a token is verified and
   // mapped to this account, the MCP route decrypts this to bind the per-request fetchImpl, so the
   // existing key -> authorize() -> scope machinery applies UNCHANGED (no authorize() change, the whole
   // point: an OAuth connection is held to exactly the scope a pasted key would be). A DB dump without
   // SECRET cannot use it. Re-minted automatically if the underlying ApiKey is later revoked/missing.
   @Column({ type: DataType.TEXT, allowNull: true })
   mcp_oauth_key_enc!: string | null;
}

export default Account;
