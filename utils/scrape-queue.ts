// Dependency-free bounded-concurrency runner (p-limit style), with NO new npm dep.
//
// WHY this exists: the cron SERP sweep used to fire one HTTP scrape promise PER keyword at
// once via Promise.allSettled. At scale (1000 sites x 50 keywords) that is 50,000 simultaneous
// outbound calls in a single request: socket exhaustion, OOM, a Serper spend spike, and a
// request timeout that loses ALL partial progress. This runner caps the number of in-flight
// workers so the same total work happens, but only `limit` scrapes are ever live at once.
//
// Contract (the load-bearing guarantees the test pins):
//   1. At most `limit` workers run concurrently. Never more, even mid-flight.
//   2. EVERY item is processed EXACTLY once (no drop, no double-run). Critical for the SERP
//      cost model: a double-run is a double Serper charge; a dropped item is a never-scraped
//      keyword. Both are real-money / correctness bugs, so this is the property under test.
//   3. Results are returned in INPUT ORDER, mirroring Promise.allSettled, so the caller's
//      existing result-aggregation (match by keyword.ID) is unaffected.
//   4. A worker that throws is captured as a rejected settlement; it never aborts the run or
//      starves the remaining items (same resilience as Promise.allSettled).

// Resolve the scrape concurrency cap from SCRAPE_CONCURRENCY, default 10. A non-numeric or
// non-positive value falls back to the default so a misconfigured env can never set it to 0
// (which would stall the run) or a negative number.
export const scrapeConcurrency = (): number => {
   const raw = parseInt(process.env.SCRAPE_CONCURRENCY || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 10;
};

// Run `worker` over every item with at most `limit` workers in flight at once. Returns a
// Promise of the per-item settlements, in INPUT ORDER, exactly like Promise.allSettled. Never
// rejects: a throwing worker becomes a 'rejected' settlement. A non-positive limit is clamped
// to 1 so the runner always makes progress.
export const runWithConcurrency = async <T, R>(
   items: T[],
   worker: (item: T, index: number) => Promise<R>,
   limit: number,
): Promise<PromiseSettledResult<R>[]> => {
   const results: PromiseSettledResult<R>[] = new Array(items.length);
   if (items.length === 0) { return results; }
   // Clamp so a 0 / negative limit cannot stall the run; never exceed the item count (no idle workers).
   const concurrency = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);

   // Shared cursor: each worker atomically claims the next index. Because JS runs this body to
   // completion between awaits (single-threaded), the `next++` read-then-increment cannot
   // interleave, so every index is claimed by exactly one worker (guarantee #2).
   let next = 0;
   const runOne = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
         const index = next;
         if (index >= items.length) { return; }
         next += 1;
         try {
            const value = await worker(items[index], index);
            results[index] = { status: 'fulfilled', value };
         } catch (reason) {
            // Capture, never propagate: one bad scrape must not abort the sweep (guarantee #4).
            results[index] = { status: 'rejected', reason };
         }
      }
   };

   const lanes: Promise<void>[] = [];
   for (let i = 0; i < concurrency; i += 1) {
      lanes.push(runOne());
   }
   await Promise.all(lanes);
   return results;
};
