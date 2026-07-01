// The single per-domain access chokepoint for s33k.
//
// Every per-domain data route (analytics, SEO, dashboards, reports, and the per-domain
// write paths) MUST resolve access through this helper instead of doing its own raw
// `Domain.findOne({ domain, ...scopeWhere(account) })`. Centralizing the check here is
// what makes the per-domain sharing feature (M2) a one-place change: today read access
// and write access are both owner-only, but M2 will EXTEND read access to domains shared
// to the caller via a future DomainShare table, while write access stays owner-only.
//
// Contract:
//  - resolveDomainAccess(account, domain)                 -> READ gate. Returns the Domain
//    row the caller may READ (today: owned; M2: owned OR shared-to-this-account), else null.
//  - resolveDomainAccess(account, domain, { write: true }) -> WRITE gate. Returns the Domain
//    row the caller may MUTATE (owner-only, now and after M2). A shared viewer is never a
//    writer, independent of their own key role.
//
// MULTI_TENANT-off / admin / null account: scopeWhere returns {}, so this resolves to a
// plain `Domain.findOne({ domain })` and single-tenant behavior is byte-for-byte unchanged.
//
// Keep this file's imports minimal (only the Domain model and scopeWhere). It must not pull
// in heavier route-level dependencies, because it is imported by many routes.

import Domain from '../database/models/domain';
import { scopeWhere } from './scope';
import { canonicalizeDomain } from './canonical-domain';
import type Account from '../database/models/account';

export type DomainAccessOptions = {
   // write === true requests the WRITE gate (owner-only). Falsy (the default) is the READ
   // gate. For M1 both gates are owner-only, so this flag is recorded but does not yet widen
   // or narrow the query; M2 makes read access strictly broader than write access (shared
   // viewers can read, never write). Routes should pass it now so the M2 change is one place.
   write?: boolean,
};

// resolveDomainAccess is the one place a per-domain route asks "may this caller touch this
// domain?". Returns the Domain row when access is granted, null when it is denied. A null
// return MUST be treated by the caller as a 403 (deny), never as "domain does not exist
// globally", so a tenant cannot probe another tenant's domain names.
//
// M1 (now): access is granted only when the caller OWNS the domain. The owner check is
// `scopeWhere(account)` (owner_id = account.ID, or {} for admin/flag-off), so the row is
// matched by its globally-@Unique domain name AND the caller's owner scope.
//
// M2 (later): for the READ gate (opts.write falsy) this will ALSO match domains shared to
// this account through the DomainShare table (owned OR shared). The WRITE gate
// (opts.write true) will stay owner-only. The two branches live here so every route inherits
// the share semantics for free the moment M2 lands.
const resolveDomainAccess = async (
   account: Account | null | undefined,
   domain: string,
   // eslint-disable-next-line @typescript-eslint/no-unused-vars
   opts?: DomainAccessOptions,
): Promise<Domain | null> => {
   // Look the Domain up by its CANONICAL form, never the raw caller-supplied string. This is the
   // load-bearing half of the cross-tenant-leak fix (third adversarial review): the authorize()
   // share-key gate already compares CANONICAL ?domain= against the CANONICAL scoped_domain, so the
   // access grant MUST resolve over the same canonical string or the two can diverge. Because every
   // Domain row is also WRITTEN canonical (pages/api/domains.ts, pages/api/onboard.ts), the @Unique
   // index makes a canonical name belong to exactly one account, so any raw variant a caller sends
   // ("example.com.", "www.example.com", "EXAMPLE.com") resolves to the SAME canonical owner
   // row, never a sibling under a different owner. Canonicalizing here also makes the leak
   // structurally impossible even if a non-canonical row somehow existed: we never query by raw.
   // canonicalizeDomain is identity-preserving (no slug-decode), so "a-b.com" stays "a-b.com".
   const canonicalDomain = canonicalizeDomain(domain);
   if (!canonicalDomain) { return null; }
   // M1: owner-only for both read and write. The `opts.write` distinction is documented and
   // accepted but has no behavioral effect yet; M2 introduces the shared-read branch here.
   const owned = await Domain.findOne({ where: { domain: canonicalDomain, ...scopeWhere(account) } });
   return owned || null;
};

export default resolveDomainAccess;
