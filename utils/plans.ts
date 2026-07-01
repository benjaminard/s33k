// Caps + active-account resolution for s33k, collapsed to permanent SINGLE-USER behavior.
//
// This project is single-user, self-hosted. There is no billing, no trial, and no per-site quantity:
// the one account is always active and has effectively unlimited caps. These functions keep their
// original exported signatures so their consumers (dashboard, start-here, domains, cron, keywords,
// onboard, caps-guard) keep compiling untouched, but they now return the single-user constants.

import type Account from '../database/models/account';

// Keywords included per site. Kept as an exported constant for anything that still references it;
// caps are unlimited in single-user mode, so this is informational only.
export const KEYWORDS_PER_SITE = 50;

// Rank-check cadence: weekly. The COGS lever, unchanged for single-user.
export const WEEKLY_CADENCE_DAYS = 7;

export type PlanCaps = {
   keywords: number,
   sites: number,
   cadenceDays: number,
   monthlyCheckBudget: number,
   pageviews: number,
};

// capsForSites derives caps for a given site count. Kept so UNLIMITED_CAPS can be built from it and
// any consumer that imports it keeps working.
export const capsForSites = (sites: number): PlanCaps => {
   const safeSites = Number.isFinite(sites) && sites > 0 ? Math.floor(sites) : 1;
   const keywords = KEYWORDS_PER_SITE * safeSites;
   return {
      sites: safeSites,
      keywords,
      cadenceDays: WEEKLY_CADENCE_DAYS,
      monthlyCheckBudget: keywords * 5,
      pageviews: 250000 * safeSites,
   };
};

// The single user is never bounded by billing: hand back very-high caps for everything.
const UNLIMITED_SITES = 100000;
export const UNLIMITED_CAPS: PlanCaps = capsForSites(UNLIMITED_SITES);

// isAccountActive is always true in single-user mode: there is no subscription to expire.
export const isAccountActive = (_account?: Account | null, _now = Date.now()): boolean => true;

// resolveCaps always returns the unlimited caps: no billing, no trial, no per-site limit.
export const resolveCaps = (_account?: Account | null, _now = Date.now()): PlanCaps => UNLIMITED_CAPS;
