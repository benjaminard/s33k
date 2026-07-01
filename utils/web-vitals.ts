// Pure aggregation logic for the Core Web Vitals report.
//
// The route layer (pages/api/web-vitals.ts) stays a thin ownership gate + DB read; ALL of the
// shaping logic lives here so it is pure and unit-testable without HTTP, mirroring how the rest
// of the app keeps logic in utils/ and gates in pages/api/. Nothing here touches the DB, the
// network, or any LLM: it takes already-loaded, scoped, period-filtered type:'webvital' rows
// and returns a JSON-ready report.
//
// What it does: for each Core Web Vital metric (LCP, CLS, INP, FID, FCP, TTFB) it computes the
// p75 (75th percentile) of the real-user samples and classifies that p75 against Google's
// published field thresholds into 'good' | 'needs-improvement' | 'poor'. p75 is the percentile
// Google itself uses to score a site's CWV (the metric is "good" only if 75% of visits beat the
// good threshold), so reporting p75 here matches how the page is actually judged in the wild.

// One plain s33k_event webvital row as read with { raw: true }. label is the metric name, the
// number lives in metric_value, page is the path the sample was captured on. is_bot/source/etc.
// are not needed by the math (the route already filtered them) so they are omitted from the type.
export type WebVitalRow = {
   page: string | null,
   label: string | null,
   metric_value: number | null,
}

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

// One metric's result: its p75, the rating that p75 earns, and how many samples backed it.
export type WebVitalMetric = {
   metric: string,
   p75: number | null,
   rating: WebVitalRating | null,
   sampleCount: number,
   unit: 'ms' | 'score',
}

// One slow page for the worst-pages breakdown: the path plus its p75 for the chosen metric.
export type WebVitalPage = {
   page: string,
   p75: number | null,
   rating: WebVitalRating | null,
   sampleCount: number,
}

export type WebVitalsReport = {
   metrics: WebVitalMetric[],
   // The metric the worstPages breakdown is computed for (LCP when present, else the metric with
   // the most samples). null when there are no samples at all.
   worstPagesMetric: string | null,
   worstPages: WebVitalPage[],
   totalSamples: number,
   note: string | null,
}

// The Core Web Vital metrics we report, in display order. INP and FID are the two
// interactivity metrics (INP is the current CWV, FID the predecessor); both are reported
// when present and each classified against its OWN thresholds.
export const WEBVITAL_METRICS = ['LCP', 'CLS', 'INP', 'FID', 'FCP', 'TTFB'] as const;

// Google's official field thresholds. `good` is the upper bound of the "good" band (value <=
// good is good); `poor` is the lower bound of the "poor" band (value > poor is poor); anything
// between is "needs-improvement". Units: ms for the timing metrics, a unitless score for CLS.
// Source: web.dev/articles/defining-core-web-vitals-thresholds. Encoded once, here, so the
// classification can never drift between the route and the MCP tool.
const THRESHOLDS: Record<string, { good: number, poor: number, unit: 'ms' | 'score' }> = {
   LCP: { good: 2500, poor: 4000, unit: 'ms' },
   CLS: { good: 0.1, poor: 0.25, unit: 'score' },
   INP: { good: 200, poor: 500, unit: 'ms' },
   FID: { good: 100, poor: 300, unit: 'ms' },
   FCP: { good: 1800, poor: 3000, unit: 'ms' },
   TTFB: { good: 800, poor: 1800, unit: 'ms' },
};

// Classify a metric value against its thresholds. good when value <= good, poor when value >
// poor, needs-improvement in between. Returns null for an unknown metric or a null value.
export const classifyWebVital = (metric: string, value: number | null): WebVitalRating | null => {
   const t = THRESHOLDS[metric];
   if (!t || value === null || !Number.isFinite(value)) { return null; }
   if (value <= t.good) { return 'good'; }
   if (value > t.poor) { return 'poor'; }
   return 'needs-improvement';
};

// 75th percentile of a list of numbers using the nearest-rank method (the rank Google's CrUX
// tooling reports against). Returns null for an empty list. Rounds CLS to 3 decimals and timing
// metrics to whole ms so the output reads cleanly; the rounding is presentational only.
export const p75 = (values: number[], unit: 'ms' | 'score'): number | null => {
   const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
   if (clean.length === 0) { return null; }
   // Nearest-rank: rank = ceil(0.75 * n), 1-indexed, clamped into range.
   const rank = Math.min(clean.length, Math.max(1, Math.ceil(0.75 * clean.length)));
   const raw = clean[rank - 1];
   return unit === 'score' ? Math.round(raw * 1000) / 1000 : Math.round(raw);
};

// Build the full report from raw webvital rows. The rows are already ownership-scoped and
// period-filtered by the caller. Empty input yields an explanatory note (the tracking script
// may predate this feature, or no page-hide has fired yet to flush a sample).
export const buildWebVitals = (rows: WebVitalRow[]): WebVitalsReport => {
   const totalSamples = rows.length;
   if (totalSamples === 0) {
      return {
         metrics: WEBVITAL_METRICS.map((metric) => ({
            metric,
            p75: null,
            rating: null,
            sampleCount: 0,
            unit: THRESHOLDS[metric].unit,
         })),
         worstPagesMetric: null,
         worstPages: [],
         totalSamples: 0,
         note: 'No Core Web Vitals samples yet. The s33k tracking script may predate this feature, '
            + 'or no page has been hidden/unloaded yet to flush a field measurement. Samples appear '
            + 'once visitors load pages with an up-to-date s33k.js and leave them.',
      };
   }

   // Bucket metric_value samples by metric name, ignoring rows whose label is not a known metric
   // or whose value is missing (defense-in-depth; collect.ts already enforces both at ingest).
   const byMetric = new Map<string, number[]>();
   WEBVITAL_METRICS.forEach((m) => byMetric.set(m, []));
   rows.forEach((row) => {
      const metric = typeof row.label === 'string' ? row.label : '';
      const bucket = byMetric.get(metric);
      if (bucket && typeof row.metric_value === 'number' && Number.isFinite(row.metric_value)) {
         bucket.push(row.metric_value);
      }
   });

   const metrics: WebVitalMetric[] = WEBVITAL_METRICS.map((metric) => {
      const unit = THRESHOLDS[metric].unit;
      const samples = byMetric.get(metric) ?? [];
      const value = p75(samples, unit);
      return { metric, p75: value, rating: classifyWebVital(metric, value), sampleCount: samples.length, unit };
   });

   // Choose the metric for the per-page breakdown: LCP when it has samples (it is the headline CWV
   // and the one users most want a "which pages are slow" answer for), else the metric with the
   // most samples, else null.
   const lcp = metrics.find((m) => m.metric === 'LCP');
   let worstPagesMetric: string | null = null;
   if (lcp && lcp.sampleCount > 0) {
      worstPagesMetric = 'LCP';
   } else {
      const withSamples = metrics.filter((m) => m.sampleCount > 0);
      if (withSamples.length > 0) {
         worstPagesMetric = withSamples.reduce((best, m) => (m.sampleCount > best.sampleCount ? m : best)).metric;
      }
   }

   const worstPages = worstPagesMetric ? buildWorstPages(rows, worstPagesMetric) : [];
   return { metrics, worstPagesMetric, worstPages, totalSamples, note: null };
};

// Per-path p75 for one metric, sorted worst (highest p75) first so the user sees WHICH pages are
// slow. CLS sorts highest-first too: a higher CLS is a worse (more shifty) page, same direction as
// the timing metrics where higher is slower. Limited to keep the response bounded.
export const buildWorstPages = (rows: WebVitalRow[], metric: string, limit = 20): WebVitalPage[] => {
   const unit = THRESHOLDS[metric]?.unit ?? 'ms';
   const byPage = new Map<string, number[]>();
   rows.forEach((row) => {
      if ((typeof row.label === 'string' ? row.label : '') !== metric) { return; }
      if (typeof row.metric_value !== 'number' || !Number.isFinite(row.metric_value)) { return; }
      const page = typeof row.page === 'string' && row.page ? row.page : '/';
      const bucket = byPage.get(page) ?? [];
      bucket.push(row.metric_value);
      byPage.set(page, bucket);
   });

   const pages: WebVitalPage[] = [];
   byPage.forEach((samples, page) => {
      const value = p75(samples, unit);
      pages.push({ page, p75: value, rating: classifyWebVital(metric, value), sampleCount: samples.length });
   });
   pages.sort((a, b) => (b.p75 ?? -1) - (a.p75 ?? -1));
   return pages.slice(0, limit);
};
