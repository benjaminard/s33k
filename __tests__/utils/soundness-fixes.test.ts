/**
 * Regression tests for the code-soundness review fixes. Each block pins one behavioral fix so the
 * bug cannot silently come back. All pure (no DB, no network): the functions under test take plain
 * inputs and return plain outputs.
 */

import { getKeywordsInsight, sortInsightItems } from '../../utils/insight';
import { buildEntryPageReport } from '../../utils/entry-page-report';
import { aggregateTrafficPages } from '../../utils/aggregate-traffic-pages';
import { normalizeHistoryDateKey, historyDateMs } from '../../utils/history-date';
import { computeRankMovers } from '../../utils/rank-movers';
import type { NormalizedPage } from '../../utils/analytics';
import type { SessionAgg } from '../../utils/sessionize';

// ---------------------------------------------------------------------------
// #1: parseKeywords must not crash on a NULL lastUpdateError.
// ---------------------------------------------------------------------------
// parseKeywords imports the Keyword model (sequelize/uuid ESM), which jest cannot transform, so it is
// mocked here exactly like every other route test. We re-import after the mock and assert the guard.
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: class {} }));
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const parseKeywords = require('../../utils/parseKeywords').default as (rows: any[]) => any[];

describe('parseKeywords: NULL lastUpdateError does not throw (review #1)', () => {
   const base = { history: '{}', tags: '[]', lastResult: '[]', target_page: '/x' };

   it('treats a NULL lastUpdateError as false instead of throwing on .includes', () => {
      const rows = [{ ...base, lastUpdateError: null }];
      expect(() => parseKeywords(rows)).not.toThrow();
      expect(parseKeywords(rows)[0].lastUpdateError).toBe(false);
   });

   it('treats undefined / non-string lastUpdateError as false too', () => {
      expect(parseKeywords([{ ...base, lastUpdateError: undefined }])[0].lastUpdateError).toBe(false);
      expect(parseKeywords([{ ...base }])[0].lastUpdateError).toBe(false);
   });

   it("still parses a real JSON error blob, and 'false' stays false", () => {
      const err = JSON.stringify({ date: '2026-06-16', error: 'boom' });
      expect(parseKeywords([{ ...base, lastUpdateError: err }])[0].lastUpdateError).toEqual({ date: '2026-06-16', error: 'boom' });
      expect(parseKeywords([{ ...base, lastUpdateError: 'false' }])[0].lastUpdateError).toBe(false);
   });

   it('does not poison a whole batch when one row has NULL', () => {
      const rows = [{ ...base, lastUpdateError: null }, { ...base, lastUpdateError: 'false' }];
      expect(() => parseKeywords(rows)).not.toThrow();
      expect(parseKeywords(rows)).toHaveLength(2);
   });
});

// ---------------------------------------------------------------------------
// #5: getKeywordsInsight countries count is the distinct country count, not always 1.
// ---------------------------------------------------------------------------
describe('getKeywordsInsight: countries counts distinct countries (review #5)', () => {
   it('reports the number of distinct countries a keyword ranks in', () => {
      const scData: any = {
         thirtyDays: [
            { keyword: 'seo tool', country: 'USA', clicks: 10, impressions: 100, ctr: 0.1, position: 3, page: '/a' },
            { keyword: 'seo tool', country: 'GBR', clicks: 5, impressions: 50, ctr: 0.1, position: 5, page: '/a' },
            { keyword: 'seo tool', country: 'CAN', clicks: 2, impressions: 20, ctr: 0.1, position: 7, page: '/a' },
         ],
      };
      const out = getKeywordsInsight(scData, '', 'thirtyDays');
      const row = out.find((r) => r.keyword === 'seo tool');
      expect(row).toBeDefined();
      // The bug pushed itm.keyword (always the same string) so this was always 1; now it is 3.
      expect(row!.countries).toBe(3);
   });

   it('counts 1 when a keyword ranks in only one country (not vacuously always-1)', () => {
      const scData: any = {
         thirtyDays: [
            { keyword: 'solo', country: 'USA', clicks: 1, impressions: 10, ctr: 0.1, position: 4, page: '/a' },
            { keyword: 'solo', country: 'USA', clicks: 1, impressions: 10, ctr: 0.1, position: 6, page: '/a' },
         ],
      };
      const row = getKeywordsInsight(scData, '', 'thirtyDays').find((r) => r.keyword === 'solo');
      expect(row!.countries).toBe(1);
   });
});

// ---------------------------------------------------------------------------
// #7: sort comparators return 0 on ties (numeric subtraction).
// ---------------------------------------------------------------------------
describe('sortInsightItems: stable numeric comparators (review #7)', () => {
   it('orders by the key descending and keeps equal elements stable (cmp returns 0 on ties)', () => {
      const items: any = [
         { clicks: 5, impressions: 1, position: 1, tag: 'a' },
         { clicks: 5, impressions: 1, position: 1, tag: 'b' },
         { clicks: 9, impressions: 1, position: 1, tag: 'c' },
      ];
      const out = sortInsightItems(items, 'clicks');
      expect(out.map((i: any) => i.tag)).toEqual(['c', 'a', 'b']); // 9 first; the two 5s keep input order
   });
});

// ---------------------------------------------------------------------------
// #4: entry-page totalEntries reconciles with the sum of per-page entries.
// ---------------------------------------------------------------------------
const session = (over: Partial<SessionAgg>): SessionAgg => ({
   id: 's', channel: 'direct', isBot: false, device: 'desktop', country: 'USA',
   landingPage: '/', exitPage: '/', pageviewPaths: ['/'], eventTypes: new Set(),
   pageEvents: [], pageviewCount: 1, hasNonPageviewEvent: false, ...over,
});

describe('buildEntryPageReport: totalEntries reconciles with the breakdown (review #4)', () => {
   it('excludes pageview-less sessions from totalEntries (they credit no entry page)', () => {
      const sessions = [
         session({ id: 'a', landingPage: '/pricing', pageviewCount: 1 }),
         session({ id: 'b', landingPage: '/blog', pageviewCount: 1 }),
         session({ id: 'c', landingPage: '/x', pageviewCount: 0 }), // event-only, no pageview
      ];
      const report = buildEntryPageReport(sessions, [], null);
      const sumEntries = report.entryPages.reduce((n, p) => n + p.entries, 0);
      // totalEntries was sessions.length (3) before the fix, overstating vs the breakdown sum (2).
      expect(report.totalEntries).toBe(2);
      expect(sumEntries).toBe(report.totalEntries);
   });

   it('equals sessions.length when every session has a pageview', () => {
      const sessions = [
         session({ id: 'a', landingPage: '/a', pageviewCount: 2 }),
         session({ id: 'b', landingPage: '/b', pageviewCount: 1 }),
      ];
      const report = buildEntryPageReport(sessions, [], null);
      expect(report.totalEntries).toBe(2);
   });
});

// ---------------------------------------------------------------------------
// #2: aggregateTrafficPages sums rows that share a clean path (shared with briefing + scoreboard).
// ---------------------------------------------------------------------------
const page = (over: Partial<NormalizedPage>): NormalizedPage => ({
   url: 'https://x.com/p', pathClean: '/p', page_views: 0, ...over,
});

describe('aggregateTrafficPages: collapses rows by clean path (review #2)', () => {
   it('sums page_views and unique_visitors across rows with the same pathClean', () => {
      const rows = [
         page({ url: 'https://x.com/p?utm=a', pathClean: '/p', page_views: 7, unique_visitors: 4 }),
         page({ url: 'https://x.com/p', pathClean: '/p', page_views: 3, unique_visitors: 2 }),
      ];
      const out = aggregateTrafficPages(rows);
      expect(out).toHaveLength(1);
      expect(out[0].page_views).toBe(10);
      expect(out[0].unique_visitors).toBe(6);
      // The shortest url is kept as the canonical representative.
      expect(out[0].url).toBe('https://x.com/p');
   });

   it('leaves distinct clean paths as separate rows', () => {
      const rows = [page({ pathClean: '/a', page_views: 1 }), page({ pathClean: '/b', page_views: 2 })];
      expect(aggregateTrafficPages(rows)).toHaveLength(2);
   });
});

// ---------------------------------------------------------------------------
// #6: ISO history date key + backward-compat parse of the old non-padded form.
// ---------------------------------------------------------------------------
describe('history-date: ISO normalization tolerant of both formats (review #6)', () => {
   it('normalizes the old non-padded key to padded ISO', () => {
      expect(normalizeHistoryDateKey('2026-6-9')).toBe('2026-06-09');
      expect(normalizeHistoryDateKey('2026-06-09')).toBe('2026-06-09');
      expect(normalizeHistoryDateKey('not-a-date')).toBeNull();
   });

   it('parses both formats to the SAME UTC-midnight epoch ms', () => {
      expect(historyDateMs('2026-6-9')).toBe(historyDateMs('2026-06-09'));
      expect(historyDateMs('2026-06-09')).toBe(Date.parse('2026-06-09T00:00:00Z'));
      expect(Number.isNaN(historyDateMs('garbage'))).toBe(true);
   });

   it('rank-movers reads old-format history correctly (back-compat)', () => {
      // History written in the OLD format must still sort and window-clip. Window covers all of June.
      const startMs = Date.parse('2026-06-01T00:00:00Z');
      const nowMs = Date.parse('2026-06-30T00:00:00Z');
      const movers = computeRankMovers(
         [{ keyword: 'k', history: JSON.stringify({ '2026-6-2': 20, '2026-6-9': 8 }), currentPosition: 8 }],
         startMs, nowMs,
      );
      // 20 -> 8 is an improvement (climbed toward #1), delta = +12.
      expect(movers.improved[0].keyword).toBe('k');
      expect(movers.improved[0].delta).toBe(12);
   });

   it('rank-movers drops a JSON-null history value instead of reading it as rank 0 (review #9)', () => {
      const startMs = Date.parse('2026-06-01T00:00:00Z');
      const nowMs = Date.parse('2026-06-30T00:00:00Z');
      const movers = computeRankMovers(
         [{ keyword: 'k', history: JSON.stringify({ '2026-06-02': 5, '2026-06-09': null }), currentPosition: 5 }],
         startMs, nowMs,
      );
      // The null point must NOT manufacture a 5 -> 0 worsening; only one real point remains, equal to
      // the current position, so there is no movement and the keyword is not a mover.
      expect(movers.improved).toEqual([]);
      expect(movers.worsened).toEqual([]);
   });
});
