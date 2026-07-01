/**
 * Tests for utils/rate-limit.ts: the dependency-free in-memory fixed-window limiter and its
 * defense-in-depth global all-keys ceiling (audit area 1).
 */

import { rateLimit, __resetGenericRateLimit } from '../../utils/rate-limit';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
   process.env = { ...ORIGINAL_ENV };
   __resetGenericRateLimit();
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('rateLimit per-key window', () => {
   it('allows up to the limit then rejects, with a retry-after on rejection', () => {
      const now = 1_000_000;
      const opts = { limit: 3, windowMs: 60_000 };
      expect(rateLimit('k:a', opts, now).allowed).toBe(true);
      expect(rateLimit('k:a', opts, now + 1).allowed).toBe(true);
      expect(rateLimit('k:a', opts, now + 2).allowed).toBe(true);
      const fourth = rateLimit('k:a', opts, now + 3);
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfterMs).toBeGreaterThan(0);
   });

   it('resets after the window elapses', () => {
      const now = 2_000_000;
      const opts = { limit: 1, windowMs: 60_000 };
      expect(rateLimit('k:b', opts, now).allowed).toBe(true);
      expect(rateLimit('k:b', opts, now + 1).allowed).toBe(false);
      expect(rateLimit('k:b', opts, now + 60_001).allowed).toBe(true);
   });

   it('keeps distinct keys independent', () => {
      const now = 3_000_000;
      const opts = { limit: 1, windowMs: 60_000 };
      expect(rateLimit('k:c', opts, now).allowed).toBe(true);
      expect(rateLimit('k:d', opts, now).allowed).toBe(true);
   });
});

describe('rateLimit global all-keys ceiling (spoofed-key flood defense)', () => {
   it('bounds total hits across UNIQUE keys regardless of per-key limits', () => {
      // Low global ceiling so the test is fast. Each request uses a brand-new key, so every per-key
      // check passes its first hit, but the shared global counter still caps the aggregate.
      process.env.RATE_LIMIT_GLOBAL_MAX = '5';
      __resetGenericRateLimit();
      const now = 4_000_000;
      const opts = { limit: 1000, windowMs: 60_000 };
      for (let i = 0; i < 5; i += 1) {
         expect(rateLimit(`flood:${i}`, opts, now + i).allowed).toBe(true);
      }
      // The 6th unique key is rejected by the global ceiling even though its own per-key bucket is fresh.
      const overflow = rateLimit('flood:6', opts, now + 6);
      expect(overflow.allowed).toBe(false);
      expect(overflow.retryAfterMs).toBeGreaterThan(0);
   });

   it('resets the global counter after the window', () => {
      process.env.RATE_LIMIT_GLOBAL_MAX = '2';
      __resetGenericRateLimit();
      const now = 5_000_000;
      const opts = { limit: 1000, windowMs: 60_000 };
      expect(rateLimit('g:1', opts, now).allowed).toBe(true);
      expect(rateLimit('g:2', opts, now + 1).allowed).toBe(true);
      expect(rateLimit('g:3', opts, now + 2).allowed).toBe(false);
      // After the window the global ceiling resets and new keys flow again.
      expect(rateLimit('g:4', opts, now + 60_001).allowed).toBe(true);
   });

   it('is disabled when RATE_LIMIT_GLOBAL_MAX is 0', () => {
      process.env.RATE_LIMIT_GLOBAL_MAX = '0';
      __resetGenericRateLimit();
      const now = 6_000_000;
      const opts = { limit: 1000, windowMs: 60_000 };
      // 50 unique keys all pass: no global ceiling in effect.
      for (let i = 0; i < 50; i += 1) {
         expect(rateLimit(`nolimit:${i}`, opts, now + i).allowed).toBe(true);
      }
   });
});
