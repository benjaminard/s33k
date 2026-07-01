// canonicalizeDomain is the ONE way to normalize a domain string so the per-domain authorization
// gate (utils/authorize.ts) and the per-domain DB lookup (utils/domain-access.ts) reason over the
// EXACTLY same string. The security bug this exists to kill: some routes re-derived the domain
// after the gate ran (a slug-decode that turns "a-b.com" into "a.b.com", or a www/protocol strip),
// so the gate byte-checked one string while the route then looked up a DIFFERENT one. A scoped
// "share" key for "a-b.com" could sail through the gate and have the route resolve "a.b.com", a
// sibling the owner also owns. The fix is to compare and look up the SAME canonical form everywhere.
//
// IDENTITY-PRESERVING, on purpose. This canonicalizer only strips things that never change which
// host a name refers to: surrounding whitespace, case, a leading scheme, a leading "www.", any
// path/query tail, and a single trailing dot (the FQDN root dot). It MUST NOT slug-decode, i.e. it
// must never turn "-" into "." or "_" into "-". That decode changes the domain's identity (it is
// what created the escape), so doing it here would reintroduce the bug. "a-b.com" canonicalizes to
// "a-b.com", never "a.b.com".
//
// IDEMPOTENT: canonicalizeDomain(canonicalizeDomain(x)) === canonicalizeDomain(x). Each step is a
// fixed-point strip, so re-running it is a no-op. Pure, no dependencies, never throws.
//
// A non-string input (undefined, an array param like ?domain=a&domain=b, a number) returns '' so
// callers can treat the empty result as "deny / not found" with no special-casing.

export function canonicalizeDomain(raw: unknown): string {
   if (typeof raw !== 'string') { return ''; }
   let domain = raw.trim().toLowerCase();
   // Strip a leading scheme (http:// or https://) if present.
   domain = domain.replace(/^https?:\/\//, '');
   // Strip a leading "www." host label.
   domain = domain.replace(/^www\./, '');
   // Drop any path/query/fragment: everything from the first "/" onward.
   const slashIndex = domain.indexOf('/');
   if (slashIndex !== -1) { domain = domain.slice(0, slashIndex); }
   // Strip a single trailing FQDN root dot ("example.com." -> "example.com").
   if (domain.endsWith('.')) { domain = domain.slice(0, -1); }
   return domain;
}

export default canonicalizeDomain;
