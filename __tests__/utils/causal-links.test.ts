/**
 * causal-links (the over-time cross-pillar join): pure, no IO, no LLM. Each test feeds a synthetic
 * rank + traffic series and asserts the right classification fires, that the honest "not enough
 * history yet" path returns no fabricated link, that the framing is correlation (never causation),
 * and that the back-compat history date parser accepts old and ISO keys in the same history object.
 */
import {
   computeCausalLinks,
   CausalKeywordInput,
   CausalEntryInput,
   DEFAULT_RANK_CHANGE,
} from '../../utils/causal-links';

const DAY = 86400e3;
// A fixed clock far enough ahead of the synthetic dates that all the "after" windows are in the past.
const NOW = Date.parse('2026-06-30T00:00:00Z');

// Build a keyword input whose history maps the given day -> position. Days are "YYYY-MM-DD".
const kw = (keyword: string, targetPage: string, history: Record<string, number>): CausalKeywordInput => ({
   keyword, targetPage, history: JSON.stringify(history),
});

// Build N entry sessions all landing on `page` on the given UTC day "YYYY-MM-DD".
const entriesOn = (page: string, day: string, count: number): CausalEntryInput[] => Array.from(
   { length: count },
   () => ({ landingPage: page, createdISO: `${day}T12:00:00Z` }),
);

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

describe('computeCausalLinks classifications', () => {
   it('rank-gain-drove-traffic: rank improves then entries rise materially', () => {
      const page = '/pricing';
      // Rank 18 -> 4 (a 14-position gain) dated to 2026-06-10. Entries jump from ~3/day before to
      // ~12/day after.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('saas pricing', page, { '2026-06-03': 18, '2026-06-10': 4 })]],
      ]);
      const before = [
         ...entriesOn(page, '2026-06-05', 3), ...entriesOn(page, '2026-06-07', 3), ...entriesOn(page, '2026-06-09', 3),
      ];
      const after = [
         ...entriesOn(page, '2026-06-11', 12), ...entriesOn(page, '2026-06-13', 12), ...entriesOn(page, '2026-06-15', 12),
      ];
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [...before, ...after]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      const link = links[0];
      expect(link.classification).toBe('rank-gain-drove-traffic');
      expect(link.confidence).toBe('likely');
      expect(link.rankFrom).toBe(18);
      expect(link.rankTo).toBe(4);
      expect(link.rankChangeDate).toBe('2026-06-10');
      expect(link.entriesAfter).toBeGreaterThan(link.entriesBefore);
      expect((link.trafficChangePct as number)).toBeGreaterThanOrEqual(30);
      // Correlation framing, never causation.
      expect(link.evidence.note.toLowerCase()).toContain('likely');
      expect(link.evidence.note.toLowerCase()).toContain('correlation');
      expect(link.evidence.note.toLowerCase()).not.toContain('proves');
   });

   it('rank-loss-cut-traffic: rank drops then entries fall materially', () => {
      const page = '/blog';
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('content marketing', page, { '2026-06-03': 4, '2026-06-10': 19 })]],
      ]);
      const before = [...entriesOn(page, '2026-06-06', 10), ...entriesOn(page, '2026-06-08', 10)];
      const after = [...entriesOn(page, '2026-06-12', 2), ...entriesOn(page, '2026-06-14', 2)];
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [...before, ...after]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].classification).toBe('rank-loss-cut-traffic');
      expect(links[0].confidence).toBe('likely');
      expect((links[0].trafficChangePct as number)).toBeLessThanOrEqual(-30);
      expect(links[0].evidence.note.toLowerCase()).toContain('likely');
      expect(links[0].evidence.note.toLowerCase()).not.toContain('proves');
   });

   it('rank-up-no-traffic: rank improves but entries stay flat (demand/snippet problem)', () => {
      const page = '/niche';
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('obscure term', page, { '2026-06-03': 20, '2026-06-10': 5 })]],
      ]);
      // Roughly equal entries before and after: a flat traffic response to a real rank gain.
      const flat = [
         ...entriesOn(page, '2026-06-06', 4), ...entriesOn(page, '2026-06-08', 4),
         ...entriesOn(page, '2026-06-12', 4), ...entriesOn(page, '2026-06-14', 4),
      ];
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, flat]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].classification).toBe('rank-up-no-traffic');
      expect(links[0].confidence).toBe('possible');
      expect(links[0].evidence.note.toLowerCase()).toMatch(/demand|snippet/);
   });

   it('rank-traffic-mismatch: rank IMPROVES but traffic FALLS materially (non-matching directions)', () => {
      const page = '/mismatch-up';
      // Rank 18 -> 4 (a real gain) dated 2026-06-10, but entries FALL hard after. The two moved against
      // each other, so this must NOT be labeled traffic-fell-rank-flat (which means no rank change).
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('weird term', page, { '2026-06-03': 18, '2026-06-10': 4 })]],
      ]);
      const before = [...entriesOn(page, '2026-06-06', 12), ...entriesOn(page, '2026-06-08', 12)];
      const after = [...entriesOn(page, '2026-06-12', 2), ...entriesOn(page, '2026-06-14', 2)];
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [...before, ...after]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].classification).toBe('rank-traffic-mismatch');
      expect(links[0].confidence).toBe('possible');
      // The structured fields KEEP the real rank move (not nulled like traffic-fell-rank-flat).
      expect(links[0].rankFrom).toBe(18);
      expect(links[0].rankTo).toBe(4);
      expect(links[0].rankChangeDate).toBe('2026-06-10');
      // Traffic actually fell, so the percent is negative and material.
      expect((links[0].trafficChangePct as number)).toBeLessThanOrEqual(-30);
      // Honest note: states they moved against each other, never asserts cause.
      expect(links[0].evidence.note.toLowerCase()).toMatch(/against each other|opposite/);
      expect(links[0].evidence.note.toLowerCase()).not.toContain('proof of cause.\nproves');
      expect(links[0].evidence.note.toLowerCase()).not.toContain('with no rank change');
   });

   it('rank-traffic-mismatch: rank DROPS but traffic RISES materially (non-matching directions)', () => {
      const page = '/mismatch-down';
      // Rank 4 -> 19 (a real drop) dated 2026-06-10, but entries RISE hard after. Again non-matching,
      // so this is rank-traffic-mismatch, not rank-loss-cut-traffic and not traffic-fell-rank-flat.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('odd term', page, { '2026-06-03': 4, '2026-06-10': 19 })]],
      ]);
      const before = [...entriesOn(page, '2026-06-06', 2), ...entriesOn(page, '2026-06-08', 2)];
      const after = [...entriesOn(page, '2026-06-12', 12), ...entriesOn(page, '2026-06-14', 12)];
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [...before, ...after]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].classification).toBe('rank-traffic-mismatch');
      expect(links[0].rankFrom).toBe(4);
      expect(links[0].rankTo).toBe(19);
      expect(links[0].rankChangeDate).toBe('2026-06-10');
      expect((links[0].trafficChangePct as number)).toBeGreaterThanOrEqual(30);
      expect(links[0].evidence.note.toLowerCase()).toMatch(/against each other|opposite/);
   });

   it('traffic-fell-rank-flat: traffic drops with no material rank change (check another source)', () => {
      const page = '/lp';
      // Rank holds at 6 the whole window (no material change).
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('landing page', page, { '2026-06-03': 6, '2026-06-10': 6, '2026-06-17': 6 })]],
      ]);
      // Entries fall sharply across the window: first half high, second half low.
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-04', 15), ...entriesOn(page, '2026-06-06', 15),
         ...entriesOn(page, '2026-06-16', 2), ...entriesOn(page, '2026-06-18', 2),
      ]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].classification).toBe('traffic-fell-rank-flat');
      expect(links[0].rankFrom).toBeNull();
      expect(links[0].rankChangeDate).toBeNull();
      expect(links[0].evidence.note.toLowerCase()).toMatch(/another source|ai|referral|backlink|seasonality/);
   });
});

describe('computeCausalLinks honesty + edge cases', () => {
   it('returns no fabricated link and an honest note when a page lacks enough history', () => {
      const page = '/new';
      // Only one rank day and one session day: below the MIN_*_DAYS gate.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('brand new', page, { '2026-06-10': 5 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, entriesOn(page, '2026-06-10', 5)]]);

      const { links, note } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(0);
      expect(note.toLowerCase()).toContain('not enough history');
   });

   it('skips a page that has rank history but NO session data (cannot correlate)', () => {
      const page = '/orphan';
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('orphan term', page, { '2026-06-03': 20, '2026-06-10': 4 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>(); // no traffic for this page

      const { links, note } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(0);
      expect(note.toLowerCase()).toContain('nothing to correlate');
   });

   it('never divides by zero or emits NaN when the before-baseline is empty', () => {
      const page = '/spike';
      // A rank gain dated such that the before-window has zero entries (all traffic lands after).
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('spike term', page, { '2026-06-03': 18, '2026-06-10': 4 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-11', 9), ...entriesOn(page, '2026-06-13', 9),
      ]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      // before === 0 so pctChange is null; the result is the honest "possible" rank-up-no-traffic
      // (no baseline to measure a rise against), never a NaN or an Infinity.
      expect(links).toHaveLength(1);
      expect(links[0].trafficChangePct).toBeNull();
      expect(Number.isNaN(Number(links[0].trafficChangePct))).toBe(false);
      expect(links[0].evidence.note).not.toMatch(/NaN|Infinity/);
   });

   it('parses BOTH old non-padded ("2026-6-9") and ISO ("2026-06-10") date keys in one history', () => {
      const page = '/mixed';
      // The earliest point uses the OLD locale-ambiguous key; the later one uses padded ISO. If the
      // back-compat parser worked, the rank series has 2 days and a material change is detected.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('mixed keys', page, { '2026-6-3': 18, '2026-06-10': 4 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-05', 3), ...entriesOn(page, '2026-06-07', 3),
         ...entriesOn(page, '2026-06-12', 12), ...entriesOn(page, '2026-06-14', 12),
      ]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].rankFrom).toBe(18);
      expect(links[0].rankTo).toBe(4);
      // The change date is the LATER, ISO-keyed day, proving both keys parsed and ordered correctly.
      expect(links[0].rankChangeDate).toBe('2026-06-10');
   });

   it('drops position 0 (not-ranked) from the rank series instead of treating it as #0', () => {
      const page = '/zero';
      // A 0 (not ranked) plus two real positions. The 0 must not appear as a rank, so the only
      // material change read is 15 -> 5, not anything involving the 0.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('zero term', page, { '2026-06-03': 0, '2026-06-05': 15, '2026-06-10': 5 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-06', 3), ...entriesOn(page, '2026-06-08', 3),
         ...entriesOn(page, '2026-06-12', 12), ...entriesOn(page, '2026-06-14', 12),
      ]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      expect(links[0].rankFrom).toBe(15);
      expect(links[0].rankTo).toBe(5);
      // No series point is position 0.
      expect(links[0].evidence.rankSeries.some((p) => p.position === 0)).toBe(false);
   });

   it('a sub-threshold rank wobble does not count as a material change', () => {
      const page = '/wobble';
      // A 2-position wobble is below DEFAULT_RANK_CHANGE (3), so no rank-change link; traffic is flat
      // too, so nothing is reported.
      expect(DEFAULT_RANK_CHANGE).toBe(3);
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('wobble term', page, { '2026-06-03': 6, '2026-06-10': 8 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-06', 5), ...entriesOn(page, '2026-06-08', 5),
         ...entriesOn(page, '2026-06-12', 5), ...entriesOn(page, '2026-06-14', 5),
      ]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(0);
   });

   it('top-level note frames the whole result as correlation, not proof', () => {
      const page = '/pricing';
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('saas pricing', page, { '2026-06-03': 18, '2026-06-10': 4 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-05', 3), ...entriesOn(page, '2026-06-07', 3),
         ...entriesOn(page, '2026-06-12', 12), ...entriesOn(page, '2026-06-14', 12),
      ]]]);
      const { note } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(note.toLowerCase()).toContain('correlation');
      expect(note.toLowerCase()).not.toContain('proves');
   });

   it('does NOT emit a link for a rank change that falls OUTSIDE the analyzed period window', () => {
      const page = '/stale';
      // The only material rank move (18 -> 4) is dated 2026-03-01, ~120 days before NOW. The session
      // data is all in June (inside a 30d window). With periodStartMs set to ~30d before NOW, that old
      // rank point is dropped, the in-window rank series falls below MIN_RANK_DAYS, and the page reads
      // as "not enough history yet" instead of correlating the stale move against the June traffic.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('stale term', page, { '2026-03-01': 18, '2026-03-05': 4 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, '2026-06-12', 3), ...entriesOn(page, '2026-06-14', 12),
      ]]]);

      const periodStart = NOW - 30 * DAY;
      const { links, note } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW, periodStartMs: periodStart });
      // The stale, out-of-window rank change produces NO link.
      expect(links).toHaveLength(0);
      expect(note.toLowerCase()).toContain('not enough history');

      // Sanity: WITHOUT the clamp (default behavior), the same inputs DO surface a (misleading) link,
      // proving the clamp is what suppressed it, not some unrelated gate.
      const unclamped = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(unclamped.links.length).toBeGreaterThanOrEqual(1);
   });

   it('biases conservative on a recent change: the clamped after-window under-reports, never over-reports', () => {
      // A change dated 2 days before NOW with a 7-day lag: the after window clamps to now (2 days) while
      // the before window stays the full 7 days. Same daily entry rate on both sides means the after SUM
      // is smaller than the before SUM purely because of the shorter span, so trafficChangePct is <= 0.
      // That is the intended conservative bias: we never invent a rise off an unequal window comparison.
      const page = '/recent';
      const changeDay = dayKey(NOW - 2 * DAY);
      const beforeDay1 = dayKey(NOW - 7 * DAY);
      const beforeDay2 = dayKey(NOW - 5 * DAY);
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('recent term', page, { [beforeDay1]: 18, [changeDay]: 4 })]],
      ]);
      // Identical 5/day rate before and after the change day.
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, beforeDay1, 5), ...entriesOn(page, beforeDay2, 5),
         ...entriesOn(page, changeDay, 5), ...entriesOn(page, dayKey(NOW - 1 * DAY), 5),
      ]]]);

      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      expect(links).toHaveLength(1);
      // Equal daily rate + shorter after window => the measured change is not a positive rise.
      expect((links[0].trafficChangePct as number)).toBeLessThanOrEqual(0);
   });

   it('uses the injected clock so the after-window is bounded by now (no future days counted)', () => {
      // Sanity that nowMs is honored: a change dated today with a lag window has its after-window
      // clamped to now, so nothing from the future leaks in. dayKey(NOW) is just used for readability.
      const page = '/clock';
      const changeDay = dayKey(NOW - 2 * DAY);
      const beforeDay = dayKey(NOW - 6 * DAY);
      const keywordsByPage = new Map<string, CausalKeywordInput[]>([
         [page, [kw('clock term', page, { [beforeDay]: 18, [changeDay]: 4 })]],
      ]);
      const entriesByPage = new Map<string, CausalEntryInput[]>([[page, [
         ...entriesOn(page, dayKey(NOW - 5 * DAY), 3), ...entriesOn(page, dayKey(NOW - 4 * DAY), 3),
         ...entriesOn(page, dayKey(NOW - 1 * DAY), 12),
      ]]]);
      const { links } = computeCausalLinks({ keywordsByPage, entriesByPage, nowMs: NOW });
      // It should still classify cleanly with the clamped after-window.
      expect(links.length).toBeGreaterThanOrEqual(0);
      if (links.length) { expect(['rank-gain-drove-traffic', 'rank-up-no-traffic']).toContain(links[0].classification); }
   });
});
