/**
 * Pure aggregation tests for utils/eventReports.ts, the shaping logic behind the four
 * autocapture read surfaces (top_clicks, form_submissions, scroll_depth, page_engagement).
 * No DB, no HTTP: the functions take plain rows and return JSON-ready reports.
 */

import {
   eventPeriodCutoff,
   buildTopClicks,
   buildFormSubmissions,
   buildScrollDepth,
   buildPageEngagement,
   buildConversionsBySource,
   EventRow,
} from '../../utils/eventReports';

const row = (over: Partial<EventRow>): EventRow => ({
   type: 'click',
   page: '/p',
   label: '',
   selector: '',
   value: null,
   session: 's1',
   source: 'direct',
   created: new Date().toJSON(),
   ...over,
});

describe('eventPeriodCutoff', () => {
   it('returns an ISO string earlier than now for a valid period', () => {
      const cutoff = eventPeriodCutoff('7d');
      expect(typeof cutoff).toBe('string');
      expect(new Date(cutoff).getTime()).toBeLessThan(Date.now());
   });

   it('a longer window has an earlier cutoff than a shorter one', () => {
      expect(new Date(eventPeriodCutoff('90d')).getTime()).toBeLessThan(new Date(eventPeriodCutoff('7d')).getTime());
   });

   it('falls back to a 30-day window for an unparseable period', () => {
      const cutoff = new Date(eventPeriodCutoff('garbage')).getTime();
      const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
      // within a few seconds of a 30d cutoff
      expect(Math.abs(cutoff - expected)).toBeLessThan(10000);
   });
});

describe('buildTopClicks', () => {
   it('counts clicks per label+selector, sorts desc, and breaks down by page', () => {
      const rows = [
         row({ type: 'click', label: 'Buy', selector: 'button.cta', page: '/a' }),
         row({ type: 'click', label: 'Buy', selector: 'button.cta', page: '/a' }),
         row({ type: 'click', label: 'Buy', selector: 'button.cta', page: '/b' }),
         row({ type: 'click', label: 'Docs', selector: 'a.nav', page: '/a' }),
         row({ type: 'scroll', value: 50, page: '/a' }), // ignored: wrong type
      ];
      const out = buildTopClicks(rows);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ label: 'Buy', selector: 'button.cta', clickCount: 3 });
      expect(out[0].byPage).toEqual([{ page: '/a', count: 2 }, { page: '/b', count: 1 }]);
      expect(out[1]).toMatchObject({ label: 'Docs', clickCount: 1 });
   });

   it('respects the limit', () => {
      const rows = Array.from({ length: 5 }, (_, i) => row({ type: 'click', label: `L${i}`, selector: `s${i}` }));
      expect(buildTopClicks(rows, 2)).toHaveLength(2);
   });
});

describe('buildFormSubmissions', () => {
   it('counts submissions per form and totals them, ignoring other types', () => {
      const rows = [
         row({ type: 'form_submit', label: 'signup', page: '/a' }),
         row({ type: 'form_submit', label: 'signup', page: '/b' }),
         row({ type: 'form_submit', label: 'contact', page: '/c' }),
         row({ type: 'click', label: 'signup' }), // ignored
      ];
      const { forms, totalSubmissions } = buildFormSubmissions(rows);
      expect(totalSubmissions).toBe(3);
      expect(forms[0]).toMatchObject({ label: 'signup', submissionCount: 2 });
      expect(forms[1]).toMatchObject({ label: 'contact', submissionCount: 1 });
   });

   it('labels an unnamed form "form"', () => {
      const { forms } = buildFormSubmissions([row({ type: 'form_submit', label: '' })]);
      expect(forms[0].label).toBe('form');
   });
});

describe('buildScrollDepth', () => {
   it('averages and maxes scroll percent per page and builds a histogram', () => {
      const rows = [
         row({ type: 'scroll', value: 20, page: '/a', session: 's1' }),
         row({ type: 'scroll', value: 80, page: '/a', session: 's2' }),
         row({ type: 'scroll', value: 100, page: '/b', session: 's3' }),
      ];
      const { pages, distribution } = buildScrollDepth(rows);
      const a = pages.find((p) => p.page === '/a');
      expect(a).toMatchObject({ avgScrollDepth: 50, maxScrollDepth: 80, sessions: 2 });
      expect(distribution).toEqual({ '0-25': 1, '25-50': 0, '50-75': 0, '75-100': 2 });
   });

   it('clamps out-of-range values into 0-100', () => {
      const { pages } = buildScrollDepth([row({ type: 'scroll', value: 250, page: '/a' })]);
      expect(pages[0].maxScrollDepth).toBe(100);
   });

   it('uses the MAX scroll percent per session, not the sum of every scroll event (regression)', () => {
      const rows = [
         // One session firing many scroll events as it scrolls deeper; its depth is the MAX (90).
         row({ type: 'scroll', value: 25, page: '/a', session: 's1' }),
         row({ type: 'scroll', value: 50, page: '/a', session: 's1' }),
         row({ type: 'scroll', value: 90, page: '/a', session: 's1' }),
         // A second session on the same page reaching 30.
         row({ type: 'scroll', value: 10, page: '/a', session: 's2' }),
         row({ type: 'scroll', value: 30, page: '/a', session: 's2' }),
      ];
      const { pages, distribution } = buildScrollDepth(rows);
      const a = pages.find((p) => p.page === '/a');
      // Per-session maxes are 90 and 30 -> avg 60, max 90, 2 sessions. The old bug summed every event
      // (205 / 2 = 102.5), above 100% for a percent metric.
      expect(a).toMatchObject({ avgScrollDepth: 60, maxScrollDepth: 90, sessions: 2 });
      // Histogram buckets per-session maxes (one per session), not per scroll event: 30 -> 25-50, 90 -> 75-100.
      expect(distribution).toEqual({ '0-25': 0, '25-50': 1, '50-75': 0, '75-100': 1 });
   });
});

describe('buildPageEngagement', () => {
   it('sums and averages active seconds per page and computes a site average', () => {
      const rows = [
         row({ type: 'engagement', value: 10, page: '/a', session: 's1' }),
         row({ type: 'engagement', value: 30, page: '/a', session: 's2' }),
         row({ type: 'engagement', value: 20, page: '/b', session: 's3' }),
      ];
      const { pages, siteAvgEngagementSeconds } = buildPageEngagement(rows);
      const a = pages.find((p) => p.page === '/a');
      expect(a).toMatchObject({ avgEngagementSeconds: 20, totalEngagementSeconds: 40, sessions: 2 });
      // sorted by total desc, so /a is first
      expect(pages[0].page).toBe('/a');
      expect(siteAvgEngagementSeconds).toBe(20); // 60 secs across 3 sessions
   });

   it('returns 0 site average with no engagement rows', () => {
      const { pages, siteAvgEngagementSeconds } = buildPageEngagement([row({ type: 'click' })]);
      expect(pages).toHaveLength(0);
      expect(siteAvgEngagementSeconds).toBe(0);
   });
});

describe('buildConversionsBySource', () => {
   it('attributes form_submit conversions to source with counts, share, and top source', () => {
      const rows = [
         row({ type: 'form_submit', source: 'ai', session: 's1' }),
         row({ type: 'form_submit', source: 'ai', session: 's2' }),
         row({ type: 'form_submit', source: 'organic-search', session: 's3' }),
         row({ type: 'form_submit', source: 'direct', session: 's4' }),
         // a non-conversion event must not be counted as a conversion
         row({ type: 'click', source: 'ai', session: 's1' }),
      ];
      const out = buildConversionsBySource(rows);
      expect(out.event).toBe('form_submit');
      expect(out.totalConversions).toBe(4);
      expect(out.topSource).toEqual({ source: 'ai', count: 2 });
      const ai = out.conversions.find((c) => c.source === 'ai');
      expect(ai?.count).toBe(2);
      expect(ai?.share).toBe(50); // 2 of 4
      // sorted by count desc, so the top source leads
      expect(out.conversions[0].source).toBe('ai');
   });

   it('defaults a missing/empty source to direct so a legacy row is never lost', () => {
      const out = buildConversionsBySource([
         row({ type: 'form_submit', source: null, session: 's1' }),
         row({ type: 'form_submit', source: '', session: 's2' }),
      ]);
      expect(out.totalConversions).toBe(2);
      expect(out.conversions).toHaveLength(1);
      expect(out.conversions[0]).toMatchObject({ source: 'direct', count: 2, share: 100 });
   });

   it('computes an approximate conversion rate from the per-source session base and notes it', () => {
      const rows = [
         // ai: 1 conversion across 2 distinct event-bearing sessions -> 50%
         row({ type: 'form_submit', source: 'ai', session: 's1' }),
         row({ type: 'click', source: 'ai', session: 's2' }),
      ];
      const out = buildConversionsBySource(rows);
      const ai = out.conversions.find((c) => c.source === 'ai');
      expect(ai?.conversionRate).toBe(50);
      expect(out.conversionRateNote).toMatch(/[Aa]pproximate/);
   });

   it('attributes any chosen event type, not just form_submit', () => {
      const rows = [
         row({ type: 'outbound', source: 'referral', session: 's1' }),
         row({ type: 'form_submit', source: 'ai', session: 's2' }),
      ];
      const out = buildConversionsBySource(rows, 'outbound');
      expect(out.event).toBe('outbound');
      expect(out.totalConversions).toBe(1);
      expect(out.topSource).toEqual({ source: 'referral', count: 1 });
   });

   it('returns an empty, non-throwing shape when there are no conversions', () => {
      const out = buildConversionsBySource([row({ type: 'click', source: 'ai' })]);
      expect(out.totalConversions).toBe(0);
      expect(out.conversions).toHaveLength(0);
      expect(out.topSource).toBeNull();
      expect(out.conversionRateNote).toBeNull();
   });
});
