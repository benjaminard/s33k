// Account-scoping helpers for s33k, collapsed to permanent SINGLE-USER behavior.
//
// This project is single-user, self-hosted. There is exactly one account (the admin sentinel,
// ID = 1) and it owns everything. The multi-tenant machinery that once lived here (per-owner
// scoping, share-key markers, an operator-isolation partition) is gone. These functions keep
// their original exported signatures so the ~128 call sites that spread scopeWhere(account) /
// stamp ownerIdFor(account) keep compiling untouched, but they now return the single-user
// constants: no where-clause restriction, no owner stamp, always admin.

import type Account from '../database/models/account';

// The one and only account. Legacy rows carry owner_id = null; nothing else exists.
export const ADMIN_ACCOUNT_ID = 1;

// Single-user: multi-tenancy is permanently off.
export const isMultiTenantEnabled = (): boolean => false;

// scopeWhere returns an empty where-fragment: the single user owns every row, so no scoping.
export const scopeWhere = (_account?: Account | null): Record<string, unknown> => ({});

// unscopedOperatorWhere is identical to scopeWhere in single-user mode. Kept as a distinct named
// export because pages/api/cron.ts calls it at the SERP-sweep site; it still means "no restriction".
export const unscopedOperatorWhere = (): Record<string, unknown> => ({});

// ownerIdFor returns null: new rows are stamped null owner_id, matching how single-user data is stored.
export const ownerIdFor = (_account?: Account | null): number | null => null;

// isAdminAccount is always true: the single caller is always the admin sentinel. Kept as an export
// because cron / me still reference it as the privilege predicate.
export const isAdminAccount = (_account?: Account | null): boolean => true;
