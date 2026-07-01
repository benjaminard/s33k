import type Account from '../../database/models/account';
import {
   ADMIN_ACCOUNT_ID,
   isMultiTenantEnabled,
   scopeWhere,
   ownerIdFor,
   unscopedOperatorWhere,
   isAdminAccount,
} from '../../utils/scope';

/**
 * Pure unit tests for the scoping helpers (utils/scope.ts), collapsed to single-user.
 *
 * This project is single-user, self-hosted: there is exactly one account (the admin sentinel,
 * ID = ADMIN_ACCOUNT_ID) and it owns everything. The multi-tenant machinery is gone. These
 * helpers keep their original exported signatures so the ~128 call sites keep compiling, but
 * they now return the single-user constants:
 *   - isMultiTenantEnabled() is always false.
 *   - scopeWhere(account) is always {} (no where-clause restriction, the single user owns all rows).
 *   - ownerIdFor(account) is always null (new rows carry a null owner_id).
 *   - isAdminAccount(account) is always true (the one caller is always the admin sentinel).
 *
 * No network, no DB. Account is used only as a typed shape ({ ID }).
 */

const account = (id: number): Account => ({ ID: id } as Account);

describe('isMultiTenantEnabled', () => {
   it('is permanently false in single-user mode, regardless of env', () => {
      expect(isMultiTenantEnabled()).toBe(false);
   });
});

describe('scopeWhere (read scoping)', () => {
   it('returns an empty (unscoped) where for the admin account', () => {
      expect(scopeWhere(account(ADMIN_ACCOUNT_ID))).toEqual({});
   });

   it('returns an empty where for any account id', () => {
      expect(scopeWhere(account(42))).toEqual({});
      expect(scopeWhere(account(99))).toEqual({});
   });

   it('returns an empty where for a null or undefined account', () => {
      expect(scopeWhere(null)).toEqual({});
      expect(scopeWhere(undefined)).toEqual({});
   });
});

describe('ownerIdFor (write stamping)', () => {
   it('stamps null for the admin account', () => {
      expect(ownerIdFor(account(ADMIN_ACCOUNT_ID))).toBeNull();
   });

   it('stamps null for any account id', () => {
      expect(ownerIdFor(account(42))).toBeNull();
   });

   it('stamps null for a null or undefined account', () => {
      expect(ownerIdFor(null)).toBeNull();
      expect(ownerIdFor(undefined)).toBeNull();
   });
});

describe('isAdminAccount', () => {
   it('is always true (the single caller is the admin sentinel)', () => {
      expect(isAdminAccount(account(ADMIN_ACCOUNT_ID))).toBe(true);
      expect(isAdminAccount(null)).toBe(true);
   });
});

describe('unscopedOperatorWhere (the cron sweep read)', () => {
   it('returns an unscoped {}', () => {
      expect(unscopedOperatorWhere()).toEqual({});
   });
});

describe('ADMIN_ACCOUNT_ID', () => {
   it('is the seeded admin row id (1)', () => {
      expect(ADMIN_ACCOUNT_ID).toBe(1);
   });
});
