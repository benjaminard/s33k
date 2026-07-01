// Atomic billing-cap reservation for the per-unit COGS levers (sites + keywords).
//
// THE BUG THIS CLOSES (count-then-create TOCTOU). The cap-bearing write routes used to do an
// unguarded count-then-create: Keyword.count(scope) then bulkCreate, and Domain.count then create.
// Two concurrent requests each read existing = 49 against a 50-keyword cap (or existing = 0 against a
// 1-site cap), both pass the check, and both insert. The account then exceeds its plan cap, leaking the
// exact COGS lever ($7 = 1 site = 50 weekly-scraped keywords) the pricing model depends on. This module
// makes the count-and-create ATOMIC: it counts UNDER A ROW LOCK on the account inside a transaction, so
// a second concurrent reservation blocks on the lock, then re-counts and sees the first insert.
//
// FLAG-OFF / ADMIN FAST PATH (byte-for-byte unchanged single-tenant behavior). resolveCaps returns the
// very-high UNLIMITED caps when MULTI_TENANT is off OR for the admin sentinel (utils/plans.ts), so there
// is nothing to enforce. In that case we SHORT-CIRCUIT to the original behavior: NO transaction, NO lock,
// just call createFn() exactly as the routes did before. This keeps the single-tenant / example path
// lock-free and identical, and it is also what keeps the existing route tests (which mock the DB without
// a transaction() and never mock Account) green: the unlimited path never touches connection.transaction
// or Account.findOne.
//
// GRACEFUL DEGRADATION when no real transaction is available. Some unit tests mock database/database as
// a bare object with no transaction() (and do not mock the Account model). When the caps WOULD apply but
// connection.transaction is not a function, we fall back to the non-atomic count-then-create using the
// same scoped count, so behavior and the existing tests are preserved. The atomic path engages only
// against a real Sequelize connection (prod), which is exactly where the race matters.

import type Account from '../database/models/account';
import connection from '../database/database';
import KeywordModel from '../database/models/keyword';
import DomainModel from '../database/models/domain';
import { scopeWhere, ADMIN_ACCOUNT_ID, isMultiTenantEnabled } from './scope';
import { resolveCaps } from './plans';

// Which cap a reservation tripped, so the caller can map it to the right user-facing 403 copy.
export type CapKind = 'sites' | 'keywords';

// A typed error thrown when a reservation would exceed the account's effective cap. Carries WHICH cap,
// the LIMIT, and how many already exist, so the route can render the existing message verbatim without
// changing the user-facing copy. Never leaks any internal host/provider string.
export class CapExceeded extends Error {
   public readonly cap: CapKind;

   public readonly limit: number;

   public readonly existing: number;

   constructor(cap: CapKind, limit: number, existing: number) {
      super(`Cap exceeded: ${cap} (limit ${limit}, existing ${existing}).`);
      this.name = 'CapExceeded';
      this.cap = cap;
      this.limit = limit;
      this.existing = existing;
   }
}

// True when caps are UNLIMITED for this account (MULTI_TENANT off OR the admin sentinel). In that case
// there is nothing to enforce and we never take a lock. Mirrors resolveCaps' own unlimited short-circuit
// so the predicate cannot drift from the source of truth: if either condition holds, plans hands back
// UNLIMITED_CAPS and the reservation is a pure passthrough.
const isUnlimited = (account: Account | null | undefined): boolean => (
   !isMultiTenantEnabled() || Boolean(account && account.ID === ADMIN_ACCOUNT_ID)
);

// True only when a REAL Sequelize transaction API is available (prod / a real local DB). Unit tests mock
// database/database without transaction(); on that mock we degrade to the non-atomic path so the cap is
// still enforced (count-then-create) and the existing test mocks stay satisfied.
const hasRealTransaction = (): boolean => Boolean(connection && typeof (connection as any).transaction === 'function');

// Lock the account row FOR UPDATE inside the transaction, so a concurrent reservation on the same account
// serializes behind this one and re-counts after this insert commits. The lock target is the Account row
// (the billing unit), NOT the Domain/Keyword rows, because the cap is account-wide.
//
// The Account model is resolved off the LIVE Sequelize connection (connection.models.Account), the model
// sequelize-typescript registered, NOT a top-level `import Account from '...'`. WHY: caps-guard is pulled
// into the keywords route, and the route's unit tests mock `sequelize` to a bare { Op }; a static import
// of the model module would then load real sequelize-typescript against the mocked sequelize and throw at
// import time ("Class extends value undefined"). This code path only runs against a REAL connection (the
// flag-off / admin / mocked-DB paths are all short-circuited before here), where connection.models is
// fully populated, so the live-registry lookup is both safe and bundle-safe (it is the canonical
// sequelize-typescript runtime access, not the standalone-bundle runtime-require footgun CLAUDE.md warns
// about, which was specifically about webpack ESM named-export resolution).
const lockAccountRow = async (account: Account | null | undefined, t: any): Promise<void> => {
   const id = account?.ID;
   if (!id) { return; }
   const AccountModel: any = (connection as any).models?.Account;
   if (!AccountModel || typeof AccountModel.findOne !== 'function') { return; }
   // LOCK.UPDATE is sequelize's SELECT ... FOR UPDATE. The admin/flag-off path never reaches here (it is
   // short-circuited by isUnlimited above), so locking is confined to real multi-tenant reservations.
   await AccountModel.findOne({ where: { ID: id }, lock: t.LOCK.UPDATE, transaction: t });
};

// reserveSite atomically enforces the per-account SITE cap, then runs createFn to insert the domain. The
// flag-off / admin path is a no-op passthrough (no lock, no transaction). createFn receives the active
// transaction (or undefined on the passthrough / degraded path) so its insert can join the same atomic
// unit when one exists. Throws CapExceeded('sites', ...) when the account is already at its site ceiling.
export const reserveSite = async <T>(
   account: Account | null | undefined,
   createFn: (transaction?: any) => Promise<T>,
): Promise<T> => {
   // UNLIMITED: original behavior, no lock, no transaction.
   if (isUnlimited(account)) { return createFn(); }

   const cap = resolveCaps(account).sites;

   // Degraded (no real transaction available, e.g. mocked DB): non-atomic count-then-create. Still
   // enforces the cap; the race window only exists where there is no real DB to race against.
   if (!hasRealTransaction()) {
      const existing = await DomainModel.count({ where: { ...scopeWhere(account) } });
      if (existing + 1 > cap) { throw new CapExceeded('sites', cap, existing); }
      return createFn();
   }

   return (connection as any).transaction(async (t: any) => {
      await lockAccountRow(account, t);
      const existing = await DomainModel.count({ where: { ...scopeWhere(account) }, transaction: t });
      if (existing + 1 > cap) { throw new CapExceeded('sites', cap, existing); }
      return createFn(t);
   });
};

// reserveKeywordSlots atomically enforces the per-account KEYWORD cap for `count` new keywords, then runs
// createFn to insert them. The cap is account-wide (50 * paid_sites), so the count is scopeWhere(account)
// across all the account's domains, matching the original billing-cap query in keywords.ts. The flag-off
// / admin path is a no-op passthrough. createFn receives the active transaction (or undefined) so the
// bulkCreate joins the atomic unit when one exists. Throws CapExceeded('keywords', ...) when over cap.
export const reserveKeywordSlots = async <T>(
   account: Account | null | undefined,
   count: number,
   createFn: (transaction?: any) => Promise<T>,
): Promise<T> => {
   if (isUnlimited(account)) { return createFn(); }

   const cap = resolveCaps(account).keywords;

   if (!hasRealTransaction()) {
      const existing = await KeywordModel.count({ where: { ...scopeWhere(account) } });
      if (existing + count > cap) { throw new CapExceeded('keywords', cap, existing); }
      return createFn();
   }

   return (connection as any).transaction(async (t: any) => {
      await lockAccountRow(account, t);
      const existing = await KeywordModel.count({ where: { ...scopeWhere(account) }, transaction: t });
      if (existing + count > cap) { throw new CapExceeded('keywords', cap, existing); }
      return createFn(t);
   });
};
