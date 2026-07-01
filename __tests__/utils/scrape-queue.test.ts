import { runWithConcurrency, scrapeConcurrency } from '../../utils/scrape-queue';

/**
 * Tests for the bounded-concurrency runner that caps the cron SERP sweep.
 *
 * The two load-bearing guarantees (a meltdown-prevention bug + a real-money bug if broken):
 *   1. At most `limit` workers run concurrently. This is what stops 50,000 simultaneous SERP
 *      calls in one cron request. We track live workers and assert the peak never exceeds limit.
 *   2. EVERY item is processed EXACTLY once (no drop = no never-scraped keyword; no double-run =
 *      no double Serper charge), and results come back in INPUT ORDER like Promise.allSettled.
 *   3. A throwing worker becomes a 'rejected' settlement and never starves the rest.
 */

// A controllable deferred so we can hold workers "in flight" and inspect the live count.
const deferred = <T>() => {
   let resolve!: (v: T) => void;
   let reject!: (e: unknown) => void;
   const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
   return { promise, resolve, reject };
};

describe('scrapeConcurrency()', () => {
   const ORIGINAL = { ...process.env };
   afterEach(() => { process.env = { ...ORIGINAL }; });

   it('defaults to 10 when unset', () => {
      delete process.env.SCRAPE_CONCURRENCY;
      expect(scrapeConcurrency()).toBe(10);
   });

   it('reads a positive integer from SCRAPE_CONCURRENCY', () => {
      process.env.SCRAPE_CONCURRENCY = '25';
      expect(scrapeConcurrency()).toBe(25);
   });

   it('falls back to the default for a non-positive or non-numeric value', () => {
      process.env.SCRAPE_CONCURRENCY = '0';
      expect(scrapeConcurrency()).toBe(10);
      process.env.SCRAPE_CONCURRENCY = '-5';
      expect(scrapeConcurrency()).toBe(10);
      process.env.SCRAPE_CONCURRENCY = 'nonsense';
      expect(scrapeConcurrency()).toBe(10);
   });
});

describe('runWithConcurrency()', () => {
   it('never runs more than `limit` workers at once', async () => {
      const LIMIT = 3;
      const items = Array.from({ length: 20 }, (_, i) => i);
      let live = 0;
      let peak = 0;
      const gates = items.map(() => deferred<number>());

      const run = runWithConcurrency<number, number>(
         items,
         async (item) => {
            live += 1;
            peak = Math.max(peak, live);
            // Hold the worker open until its gate is released, so multiple workers can be
            // genuinely in flight at the same time and the peak is observable.
            const value = await gates[item].promise;
            live -= 1;
            return value;
         },
         LIMIT,
      );

      // Release the gates one at a time, letting the runner pull the next item each time. A
      // microtask flush between releases lets the runner schedule the replacement worker.
      for (let i = 0; i < items.length; i += 1) {
         gates[i].resolve(i * 10);
         // eslint-disable-next-line no-await-in-loop
         await Promise.resolve();
         // eslint-disable-next-line no-await-in-loop
         await Promise.resolve();
      }

      const results = await run;
      // The cap held the entire time.
      expect(peak).toBeLessThanOrEqual(LIMIT);
      expect(peak).toBeGreaterThan(0);
      // Every item produced a fulfilled settlement, in input order.
      expect(results).toHaveLength(items.length);
      results.forEach((r, i) => {
         expect(r.status).toBe('fulfilled');
         if (r.status === 'fulfilled') { expect(r.value).toBe(i * 10); }
      });
   });

   it('processes every item exactly once', async () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const counts = new Map<number, number>();

      const results = await runWithConcurrency<number, number>(
         items,
         async (item) => {
            counts.set(item, (counts.get(item) || 0) + 1);
            return item;
         },
         7,
      );

      // No item dropped, none run twice.
      expect(counts.size).toBe(items.length);
      for (const item of items) {
         expect(counts.get(item)).toBe(1);
      }
      // Results in input order.
      expect(results.map((r) => (r.status === 'fulfilled' ? r.value : -1))).toEqual(items);
   });

   it('captures a throwing worker as a rejected settlement without starving the rest', async () => {
      const items = [0, 1, 2, 3, 4];
      const results = await runWithConcurrency<number, number>(
         items,
         async (item) => {
            if (item === 2) { throw new Error(`boom ${item}`); }
            return item * 2;
         },
         2,
      );

      expect(results).toHaveLength(5);
      expect(results[2].status).toBe('rejected');
      // The other four still ran and fulfilled in order.
      for (const i of [0, 1, 3, 4]) {
         expect(results[i].status).toBe('fulfilled');
         if (results[i].status === 'fulfilled') {
            expect((results[i] as PromiseFulfilledResult<number>).value).toBe(i * 2);
         }
      }
   });

   it('returns an empty array for no items and never calls the worker', async () => {
      const worker = jest.fn(async (n: number) => n);
      const results = await runWithConcurrency<number, number>([], worker, 5);
      expect(results).toEqual([]);
      expect(worker).not.toHaveBeenCalled();
   });

   it('clamps a non-positive limit to 1 and still completes', async () => {
      const items = [1, 2, 3];
      const results = await runWithConcurrency<number, number>(items, async (n) => n, 0);
      expect(results.map((r) => (r.status === 'fulfilled' ? r.value : -1))).toEqual(items);
   });
});
