// causal_links: the cross-pillar feature only s33k can build.
//
// No single tool can answer "did my SEO actually pay off?". Ahrefs/SerpBear hold rank history but
// not YOUR sessions; Plausible/Umami hold sessions but not rank. s33k holds BOTH for one domain in
// one store, joined per page: the rank history of the keywords that target a page (SEO) AND the
// first-party landing/entry sessions on that same page (analytics). This module joins them over time
// and reports which rank CHANGE LIKELY drove which traffic CHANGE, per page.
//
// CRITICAL HONESTY (load-bearing, do not soften): this is CORRELATION, never proof. A rank move and a
// traffic move that line up in time is suggestive, not causal: seasonality, a campaign, a viral post,
// or an AI-referral shift can move traffic with no rank cause. So every link is framed with "likely",
// carries the two series points as evidence, and NEVER asserts causation. When a page has too little
// history to read a movement at all, we say "not enough history yet" rather than manufacture a link.
//
// No server-side LLM: this is pure, transparent, threshold-based rules (like analyst.ts). It returns
// structured links the USER's own LLM narrates. No IO here; the route does the reads.

import { historyDateMs, normalizeHistoryDateKey } from './history-date';

// --- Tunable thresholds, kept together so they are easy to audit. ------------------------------

// A rank move counts as "material" only when the position changes by at least this many spots. 3 is
// loose enough to catch a real climb/slip yet tight enough to ignore the daily 1-2 position jitter a
// SERP scrape shows even on a stable page.
export const DEFAULT_RANK_CHANGE = 3;
// A traffic move counts only when entries change by at least this percent versus the pre-change
// baseline. 30% filters out the day-to-day noise of small-site session counts.
export const DEFAULT_TRAFFIC_CHANGE_PCT = 30;
// How many days AFTER the rank-change date a traffic change may land and still be read as a possible
// consequence. Rank changes take a few days to show in traffic (reindex, click-through), so
// the cause must precede the effect inside this window.
export const DEFAULT_LAG_DAYS = 7;
// A page needs at least this many distinct rank-history days and this many session days before we are
// willing to read a movement at all. Below it we return the honest "not enough history yet" note.
export const MIN_RANK_DAYS = 2;
export const MIN_SESSION_DAYS = 2;

const DAY_MS = 86400e3;

// --- Inputs. The route hydrates these from Keyword rows + sessionized S33kEvent rows. -----------

// One tracked keyword's contribution to a page: its rank history JSON. Only the history is read here:
// the per-day rank series (and so every change-detection) is derived entirely from history, so there
// is no separate current-position fallback (it would bypass the date-keyed series and the honesty gate).
export type CausalKeywordInput = {
   keyword: string,
   targetPage: string,
   // Raw history JSON string from the keyword row (date -> Google position). Parsed defensively.
   history: string,
};

// One landing/entry event the page received, already classified human-only by the caller. Only the
// day matters here (we bucket entries by UTC day), plus the landing page it started on.
export type CausalEntryInput = {
   landingPage: string,
   // The session's start time as an ISO string (sessionized `created` of the first event). Bucketed
   // to a UTC day key for the daily entries series.
   createdISO: string,
};

export type CausalClassification =
   | 'rank-gain-drove-traffic'
   | 'rank-loss-cut-traffic'
   | 'rank-up-no-traffic'
   | 'rank-traffic-mismatch'
   | 'traffic-fell-rank-flat';

export type CausalLink = {
   page: string,
   classification: CausalClassification,
   // The rank series around the detected change. rankFrom is the representative position BEFORE the
   // change date, rankTo is AFTER. Both null ONLY on the 'traffic-fell-rank-flat' case (rank did not
   // move); non-null on every case where a material rank change was detected, including the
   // 'rank-traffic-mismatch' case where rank moved but traffic moved in a non-matching direction.
   rankFrom: number | null,
   rankTo: number | null,
   // ISO day the material rank change is dated to (the first day the new level is seen). Null when
   // there was no material rank change (the traffic-fell-rank-flat case).
   rankChangeDate: string | null,
   // Entries before vs after, as counts and as a percent change off the before-baseline.
   entriesBefore: number,
   entriesAfter: number,
   trafficChangePct: number | null,
   lagDays: number | null,
   // 'likely' when a material rank move AND a material traffic move line up in the SAME direction in
   // time; 'possible' otherwise (only one side moved materially, e.g. rank up but traffic flat or
   // traffic fell with flat rank, or both moved materially but in non-matching directions).
   confidence: 'likely' | 'possible',
   // The raw two-sided evidence so the narration can show the receipts, never just the verdict.
   evidence: {
      rankSeries: { date: string, position: number }[],
      entriesSeries: { date: string, entries: number }[],
      note: string,
   },
};

export type CausalLinksResult = {
   links: CausalLink[],
   note: string,
};

// Parse one keyword's history JSON into [dayKey, position] pairs, dropping unparseable entries and
// position 0 (= not ranked / not yet scraped: a real value elsewhere, but here a 0 is "no rank to
// read", so it is excluded from the daily best-position series rather than masquerading as #0).
const parseRankDays = (history: string): { day: string, pos: number }[] => {
   let obj: Record<string, unknown> = {};
   try {
      const parsed = JSON.parse(history || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { obj = parsed as Record<string, unknown>; }
   } catch { obj = {}; }
   const out: { day: string, pos: number }[] = [];
   for (const key of Object.keys(obj)) {
      const day = normalizeHistoryDateKey(key);
      if (!day) { continue; }
      const raw = obj[key];
      if (raw == null) { continue; }
      const pos = Number(raw);
      // Drop NaN and 0 (not-ranked). A real rank is >= 1; smaller is better.
      if (!Number.isFinite(pos) || pos <= 0) { continue; }
      out.push({ day, pos });
   }
   return out;
};

// Build the per-day rank series for a PAGE from all keywords that target it: for each day, the BEST
// (smallest) tracked position any of the page's keywords held that day. Best-position is the right
// representative because a page's traffic tracks its strongest-ranking term, not its average. Sorted
// ascending by day.
const buildPageRankSeries = (keywords: CausalKeywordInput[]): { date: string, position: number }[] => {
   const bestByDay = new Map<string, number>();
   for (const k of keywords) {
      for (const { day, pos } of parseRankDays(k.history)) {
         const cur = bestByDay.get(day);
         if (cur === undefined || pos < cur) { bestByDay.set(day, pos); }
      }
   }
   return Array.from(bestByDay.entries())
      .map(([date, position]) => ({ date, position }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

// Build the per-day entries series for a page: count sessions whose landing day falls on each UTC
// day. Sorted ascending by day. Days with zero entries are not emitted (the series is sparse).
const buildEntriesSeries = (entries: CausalEntryInput[]): { date: string, entries: number }[] => {
   const byDay = new Map<string, number>();
   for (const e of entries) {
      const ms = Date.parse(e.createdISO);
      if (Number.isNaN(ms)) { continue; }
      // Bucket to a UTC day key so it lines up with the UTC-midnight rank day keys.
      const day = new Date(ms).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
   }
   return Array.from(byDay.entries())
      .map(([date, n]) => ({ date, entries: n }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

// Sum entries on days within [startMs, endMs] inclusive (both bounds are UTC day-midnights).
const sumEntriesInRange = (series: { date: string, entries: number }[], startMs: number, endMs: number): number => {
   let total = 0;
   for (const p of series) {
      const ms = historyDateMs(p.date);
      if (Number.isNaN(ms)) { continue; }
      if (ms >= startMs && ms <= endMs) { total += p.entries; }
   }
   return total;
};

// Percent change off a baseline, guarded against divide-by-zero. Returns null when there is no
// baseline to measure against (before === 0), because "up from nothing" is not a percent.
const pctChange = (before: number, after: number): number | null => {
   if (before <= 0) { return null; }
   return Math.round(((after - before) / before) * 1000) / 10;
};

// Detect the single most material rank change in a page's rank series. Walks consecutive recorded
// points and returns the largest absolute position move that clears the threshold, with the day the
// new level first appears as the change date. Returns null when nothing clears the threshold.
const detectRankChange = (
   series: { date: string, position: number }[],
   minChange: number,
): { from: number, to: number, date: string, magnitude: number } | null => {
   let best: { from: number, to: number, date: string, magnitude: number } | null = null;
   for (let i = 1; i < series.length; i += 1) {
      const from = series[i - 1].position;
      const to = series[i].position;
      const magnitude = Math.abs(to - from);
      if (magnitude < minChange) { continue; }
      if (!best || magnitude > best.magnitude) {
         best = { from, to, date: series[i].date, magnitude };
      }
   }
   return best;
};

/**
 * Join a page's rank history and entry/session series and report which rank change LIKELY drove which
 * traffic change. Pure: no IO, no LLM. Honest: correlation only, never causation, and an explicit
 * "not enough history yet" when a page lacks the points to read a movement.
 *
 * @param {Object} inputs - The per-domain inputs.
 * @param {Map<string, CausalKeywordInput[]>} inputs.keywordsByPage - Tracked keywords grouped by the
 *   normalized page path they target (only pages with at least one keyword appear).
 * @param {Map<string, CausalEntryInput[]>} inputs.entriesByPage - Human-only landing sessions grouped
 *   by normalized landing-page path.
 * @param {number} [inputs.nowMs] - The clock (ms). Defaults to Date.now(). Injectable for tests.
 * @param {number} [inputs.periodStartMs] - The start of the analyzed traffic window (ms). Rank-history
 *   points OLDER than this are dropped before change-detection so a rank move from OUTSIDE the window
 *   (e.g. 90 days ago) is never correlated against the in-window, possibly-empty traffic series.
 *   Defaults to no clamp (consider all rank history) for back-compat callers and tests.
 * @param {number} [inputs.rankChange] - Min position delta to call a rank change material.
 * @param {number} [inputs.trafficChangePct] - Min percent delta to call a traffic change material.
 * @param {number} [inputs.lagDays] - Days after a rank change a traffic change may land and still count.
 * @returns {CausalLinksResult}
 */
export const computeCausalLinks = (inputs: {
   keywordsByPage: Map<string, CausalKeywordInput[]>,
   entriesByPage: Map<string, CausalEntryInput[]>,
   nowMs?: number,
   periodStartMs?: number,
   rankChange?: number,
   trafficChangePct?: number,
   lagDays?: number,
}): CausalLinksResult => {
   const nowMs = inputs.nowMs ?? Date.now();
   const periodStartMs = inputs.periodStartMs;
   const minRank = inputs.rankChange ?? DEFAULT_RANK_CHANGE;
   const minTrafficPct = inputs.trafficChangePct ?? DEFAULT_TRAFFIC_CHANGE_PCT;
   const lagDays = inputs.lagDays ?? DEFAULT_LAG_DAYS;

   const links: CausalLink[] = [];
   let pagesConsidered = 0;
   let pagesSkippedForHistory = 0;

   // Only pages that have BOTH a tracked-keyword rank history AND session/entry data can be joined.
   // Iterate the keyword pages and require a matching entries bucket.
   for (const [page, keywords] of inputs.keywordsByPage.entries()) {
      const entries = inputs.entriesByPage.get(page);
      if (!entries || entries.length === 0) { continue; }
      pagesConsidered += 1;

      const fullRankSeries = buildPageRankSeries(keywords);
      const entriesSeries = buildEntriesSeries(entries);

      // Clamp the rank series considered for change-detection to the SAME period window as the entries.
      // The entries are loaded period-clamped (route loads S33kEvent with created >= periodStart) but
      // the keyword history blob is unclamped, and detectRankChange returns the LARGEST-magnitude move
      // across whatever it is given. Without this clamp, a big rank move from BEFORE the window (e.g. 90
      // days ago) would be correlated against an in-window traffic series that has no data spanning it,
      // surfacing a misleading link. Keep the point ON periodStart so a change dated to the first
      // in-window day is still readable. With no periodStartMs (default), nothing is dropped.
      const rankSeries = periodStartMs === undefined
         ? fullRankSeries
         : fullRankSeries.filter((p) => {
            const ms = historyDateMs(p.date);
            return Number.isNaN(ms) || ms >= periodStartMs;
         });

      // Honesty gate: too few distinct days on either side and we cannot read a movement. Skip with a
      // count rather than guessing. Applied to the in-window rank series, so a page whose only rank
      // movement is out-of-window correctly reads as "not enough history yet" rather than a stale link.
      if (rankSeries.length < MIN_RANK_DAYS || entriesSeries.length < MIN_SESSION_DAYS) {
         pagesSkippedForHistory += 1;
         continue;
      }

      const change = detectRankChange(rankSeries, minRank);

      if (change) {
         // A material rank move happened. Compare entries in the before/after windows around the change
         // date: after window is [D, min(D+lag, now)]; before window is [D-1-lag, D-1]. When the change
         // is RECENT (dated within `lagDays` of now), afterEnd clamps to now so the after window covers
         // FEWER days than the before window. We deliberately leave the before window full rather than
         // shrinking it: that under-counts a recent rise (the after sum is over a shorter span), which
         // biases CONSERVATIVE (we under-report a movement, never over-report one) and keeps an honest
         // tool from manufacturing a strong signal off a half-formed after window.
         const changeMs = historyDateMs(change.date);
         const lagMs = lagDays * DAY_MS;
         const afterStart = changeMs;
         const afterEnd = Math.min(changeMs + lagMs, nowMs);
         const beforeEnd = changeMs - DAY_MS;
         const beforeStart = beforeEnd - lagMs;

         const entriesBefore = sumEntriesInRange(entriesSeries, beforeStart, beforeEnd);
         const entriesAfter = sumEntriesInRange(entriesSeries, afterStart, afterEnd);
         const trafficChangePct = pctChange(entriesBefore, entriesAfter);

         // Rank improved means the position got SMALLER (closer to #1).
         const rankImproved = change.to < change.from;
         const trafficMovedMaterially = trafficChangePct !== null && Math.abs(trafficChangePct) >= minTrafficPct;
         const trafficRose = trafficChangePct !== null && trafficChangePct > 0;

         let classification: CausalClassification;
         let confidence: 'likely' | 'possible';
         let note: string;

         if (rankImproved && trafficMovedMaterially && trafficRose) {
            classification = 'rank-gain-drove-traffic';
            confidence = 'likely';
            note = `Rank improved from #${change.from} to #${change.to} around ${change.date}, and entries to `
               + `${page} rose ${trafficChangePct}% in the ${lagDays} days after. These two moves line up in time, `
               + 'so the rank gain LIKELY drove the traffic gain. This is correlation, not proof: a campaign or '
               + 'seasonality could also explain the rise. Check the two series below.';
         } else if (!rankImproved && trafficMovedMaterially && !trafficRose) {
            classification = 'rank-loss-cut-traffic';
            confidence = 'likely';
            note = `Rank dropped from #${change.from} to #${change.to} around ${change.date}, and entries to `
               + `${page} fell ${Math.abs(trafficChangePct as number)}% in the ${lagDays} days after. The two moves `
               + 'line up in time, so the rank loss LIKELY cut the traffic. This is correlation, not proof: a '
               + 'lost AI referral or seasonality could also explain the drop. Check the two series below.';
         } else if (rankImproved && !trafficMovedMaterially) {
            classification = 'rank-up-no-traffic';
            confidence = 'possible';
            const moved = trafficChangePct === null ? 'had no prior baseline to measure against' : `moved only ${trafficChangePct}%`;
            note = `Rank improved from #${change.from} to #${change.to} around ${change.date}, but entries to `
               + `${page} ${moved} in the ${lagDays} days after. The rank gain did not convert into more `
               + 'traffic. That points to a demand problem (few people search this term) or a snippet problem (the '
               + 'listing is not earning clicks): improve the title and meta description, or target a higher-demand term.';
         } else {
            // A material rank move happened, but traffic moved in a NON-matching direction: rank improved
            // yet traffic fell materially, or rank dropped yet traffic rose materially (the only cases
            // left after the three above). This is its OWN classification, never 'traffic-fell-rank-flat'
            // (which is reserved for the genuine no-rank-change case, rankFrom/rankTo null) and never
            // 'rank-up-no-traffic' (reserved for a rank gain with immaterial traffic): a narrating LLM
            // keys off the label, so an honest label is load-bearing here. The structured fields keep the
            // real rank move; the note states plainly that the two moved against each other.
            classification = 'rank-traffic-mismatch';
            confidence = 'possible';
            const dir = rankImproved
               ? `Rank improved from #${change.from} to #${change.to}`
               : `Rank dropped from #${change.from} to #${change.to}`;
            const trafficWord = trafficChangePct === null ? 'no baseline to measure' : `moved ${trafficChangePct}%`;
            note = `${dir} around ${change.date}, but entries to ${page} ${trafficWord} in the ${lagDays} days after, `
               + 'the OPPOSITE direction you would expect from the rank move. Rank and traffic moved against each '
               + 'other, so the rank change did NOT drive this traffic change: another factor (a campaign, '
               + 'seasonality, an AI-referral shift, or a different keyword) is likely at work. This is correlation '
               + 'analysis only, never proof of cause.';
         }

         links.push({
            page,
            classification,
            rankFrom: change.from,
            rankTo: change.to,
            rankChangeDate: change.date,
            entriesBefore,
            entriesAfter,
            trafficChangePct,
            lagDays,
            confidence,
            evidence: { rankSeries, entriesSeries, note },
         });
         continue;
      }

      // No material rank change. The only remaining link worth surfacing is "traffic fell while rank
      // stayed flat", which redirects the user to ANOTHER source (e.g. an AI referral that dried up).
      // Compare the first vs the second half of the entries series to read a within-window fall.
      const mid = Math.floor(entriesSeries.length / 2);
      const firstHalf = entriesSeries.slice(0, mid).reduce((s, p) => s + p.entries, 0);
      const secondHalf = entriesSeries.slice(mid).reduce((s, p) => s + p.entries, 0);
      const trafficChangePct = pctChange(firstHalf, secondHalf);
      const fellMaterially = trafficChangePct !== null && trafficChangePct <= -minTrafficPct;

      if (fellMaterially) {
         links.push({
            page,
            classification: 'traffic-fell-rank-flat',
            rankFrom: null,
            rankTo: null,
            rankChangeDate: null,
            entriesBefore: firstHalf,
            entriesAfter: secondHalf,
            trafficChangePct,
            lagDays: null,
            confidence: 'possible',
            evidence: {
               rankSeries,
               entriesSeries,
               note: `Entries to ${page} fell ${Math.abs(trafficChangePct as number)}% across the window while its `
                  + 'tracked rank stayed flat (no material rank change). SEO did not cause this, so check another '
                  + 'source: an AI-engine referral that dried up, a lost backlink, a campaign that ended, or '
                  + 'seasonality. This is correlation only; it points you at where to look, it does not prove cause.',
            },
         });
      }
   }

   // Sort the strongest signals first: 'likely' before 'possible', then by absolute traffic move.
   links.sort((a, b) => {
      if (a.confidence !== b.confidence) { return a.confidence === 'likely' ? -1 : 1; }
      return Math.abs(b.trafficChangePct ?? 0) - Math.abs(a.trafficChangePct ?? 0);
   });

   let note: string;
   if (pagesConsidered === 0) {
      note = 'No page has BOTH tracked-keyword rank history and first-party session data yet, so there is nothing '
         + 'to correlate. Add a target_page to your keywords and install the s33k.js tracking script, then let a '
         + 'few days of both accrue.';
   } else if (links.length === 0) {
      note = `Looked at ${pagesConsidered} page(s) with both rank history and traffic. ${pagesSkippedForHistory} had `
         + 'not enough history yet (need a few days of rank scrapes and sessions). None showed a rank change and a '
         + 'traffic change lined up in time. That is a clean read, not a failure: nothing material to report this window.';
   } else {
      note = `Found ${links.length} page(s) where a rank change and a traffic change line up in time, across `
         + `${pagesConsidered} page(s) examined. Everything below is CORRELATION, not proof: the two series are `
         + 'attached as evidence so you can judge it yourself. "likely" means both rank and traffic moved materially '
         + 'together; "possible" means only one side moved. A rank move can precede a traffic move that another '
         + 'factor (campaign, seasonality, AI referral) actually caused.';
   }

   return { links, note };
};
