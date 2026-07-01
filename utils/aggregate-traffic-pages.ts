import type { NormalizedPage } from './analytics';

// Shared per-path aggregation for the cross-pillar joins. The provider's getPageTraffic
// can return several raw rows that all normalize to ONE clean path: "/page" and "/page?utm=x" both
// have pathClean "/page". Without aggregating first, a join keyed on pathClean either double-counts
// (iterating raw rows emits two rows for the same page) or silently drops a row (a plain Map.set on
// pathClean keeps only the last). briefing.ts and scoreboard.ts both join traffic to keywords by
// clean path, so they MUST aggregate identically or the two flagship views disagree on the same data.
//
// Aggregation rule: sum page_views and unique_visitors across rows sharing a clean path; keep the
// representative row's other metrics (page_title, bounce_rate, avg_duration, metricsNote) from the
// row with the SHORTEST url (the canonical/un-parameterized form, e.g. "/page" over "/page?utm=x").
// page-level bounce_rate / avg_duration are not summable, so taking the canonical row's value is the
// honest choice rather than fabricating a weighted average across query-string variants.
export const aggregateTrafficPages = (pages: NormalizedPage[]): NormalizedPage[] => {
   const byPath = new Map<string, NormalizedPage>();
   pages.forEach((p) => {
      const existing = byPath.get(p.pathClean);
      if (!existing) {
         byPath.set(p.pathClean, {
            url: p.url,
            pathClean: p.pathClean,
            page_views: p.page_views || 0,
            page_title: p.page_title,
            unique_visitors: p.unique_visitors,
            bounce_rate: p.bounce_rate,
            avg_duration: p.avg_duration,
            metricsNote: p.metricsNote,
         });
         return;
      }
      existing.page_views += (p.page_views || 0);
      if (typeof p.unique_visitors === 'number') {
         existing.unique_visitors = (existing.unique_visitors || 0) + p.unique_visitors;
      }
      // The shortest url is the canonical representative; adopt its non-summable metrics too.
      if (p.url && (!existing.url || p.url.length < existing.url.length)) {
         existing.url = p.url;
         existing.page_title = p.page_title;
         existing.bounce_rate = p.bounce_rate;
         existing.avg_duration = p.avg_duration;
         existing.metricsNote = p.metricsNote;
      }
   });
   return Array.from(byPath.values());
};
