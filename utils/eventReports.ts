// Aggregations over the s33k_event table (the GA4-killer autocapture store).
//
// The route layer (pages/api/top-clicks.ts, form-submissions.ts, scroll-depth.ts,
// page-engagement.ts) stays a thin ownership gate + DB read; ALL of the shaping logic
// lives here so it is pure and unit-testable without HTTP, mirroring how the rest of the
// app keeps logic in utils/ and gates in pages/api/.
//
// Every function takes already-loaded plain event rows (scoped + period-filtered by the
// caller) and returns a JSON-ready report. Nothing here touches the DB, the network, or
// any LLM. owner_id scoping happens in the route via scopeWhere; these functions never
// see another tenant's rows.

// One plain s33k_event row as read with { raw: true }. value/selector are nullable.
// source is the session's first-touch class ('direct' | 'referral' | 'organic-search' | 'ai')
// or a bare referral host; it is nullable on legacy rows captured before source existed.
export type EventRow = {
   type: string,
   page: string | null,
   label: string | null,
   selector: string | null,
   value: number | null,
   session: string | null,
   source: string | null,
   created: string,
}

// Parse a period string ("30d", "7d", "12h", "4w", "3m") into the earliest `created`
// ISO timestamp to include. Anything unparseable falls back to a 30-day window. This is
// the same grammar the analytics providers use, so an event
// window matches a traffic window for the same period string.
export const eventPeriodCutoff = (period: string): string => {
   const match = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   let days = 30;
   if (match) {
      const n = Number(match[1]);
      const unit = match[2].toLowerCase();
      const perUnitDays: Record<string, number> = { h: n / 24, d: n, w: n * 7, m: n * 30 };
      days = perUnitDays[unit] ?? 30;
   }
   const ms = Math.max(1, days) * 24 * 60 * 60 * 1000;
   return new Date(Date.now() - ms).toJSON();
};

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// top_clicks: the most-clicked elements, each keyed by its visible text + selector,
// with a per-page breakdown so you can see where a given CTA is clicked.
// ---------------------------------------------------------------------------
export type TopClickRow = {
   label: string,
   selector: string,
   clickCount: number,
   byPage: Array<{ page: string, count: number }>,
}

export const buildTopClicks = (rows: EventRow[], limit = 100): TopClickRow[] => {
   const map = new Map<string, TopClickRow & { _pages: Map<string, number> }>();
   rows.forEach((row) => {
      if (row.type !== 'click') { return; }
      const label = (row.label || '').trim();
      const selector = (row.selector || '').trim();
      const page = (row.page || '').trim();
      const key = `${label} ${selector}`;
      let entry = map.get(key);
      if (!entry) {
         entry = { label, selector, clickCount: 0, byPage: [], _pages: new Map<string, number>() };
         map.set(key, entry);
      }
      entry.clickCount += 1;
      entry._pages.set(page, (entry._pages.get(page) || 0) + 1);
   });
   const out = Array.from(map.values()).map((entry) => ({
      label: entry.label,
      selector: entry.selector,
      clickCount: entry.clickCount,
      byPage: Array.from(entry._pages.entries())
         .map(([page, count]) => ({ page, count }))
         .sort((a, b) => b.count - a.count),
   }));
   out.sort((a, b) => b.clickCount - a.clickCount);
   return out.slice(0, limit);
};

// ---------------------------------------------------------------------------
// form_submissions: how often each form was submitted, plus a per-page breakdown.
// ---------------------------------------------------------------------------
export type FormSubmissionRow = {
   label: string,
   submissionCount: number,
   byPage: Array<{ page: string, count: number }>,
}

export const buildFormSubmissions = (rows: EventRow[]): { forms: FormSubmissionRow[], totalSubmissions: number } => {
   const map = new Map<string, FormSubmissionRow & { _pages: Map<string, number> }>();
   let total = 0;
   rows.forEach((row) => {
      if (row.type !== 'form_submit') { return; }
      total += 1;
      const label = (row.label || '').trim() || 'form';
      const page = (row.page || '').trim();
      let entry = map.get(label);
      if (!entry) {
         entry = { label, submissionCount: 0, byPage: [], _pages: new Map<string, number>() };
         map.set(label, entry);
      }
      entry.submissionCount += 1;
      entry._pages.set(page, (entry._pages.get(page) || 0) + 1);
   });
   const forms = Array.from(map.values()).map((entry) => ({
      label: entry.label,
      submissionCount: entry.submissionCount,
      byPage: Array.from(entry._pages.entries())
         .map(([page, count]) => ({ page, count }))
         .sort((a, b) => b.count - a.count),
   }));
   forms.sort((a, b) => b.submissionCount - a.submissionCount);
   return { forms, totalSubmissions: total };
};

// ---------------------------------------------------------------------------
// scroll_depth: per-page average and max scroll percent, plus a site-wide histogram.
// value on a scroll event is the max scroll percent (0-100) for that session/page.
// ---------------------------------------------------------------------------
export type ScrollDepthRow = {
   page: string,
   avgScrollDepth: number,
   maxScrollDepth: number,
   sessions: number,
}

export type ScrollDistribution = {
   '0-25': number,
   '25-50': number,
   '50-75': number,
   '75-100': number,
}

export const buildScrollDepth = (rows: EventRow[]): { pages: ScrollDepthRow[], distribution: ScrollDistribution } => {
   // Scroll depth is the MAX percent reached per session/page. The tracker fires MANY scroll events
   // per session as the visitor goes deeper, so we must reduce to ONE value per (page, session) (the
   // deepest point that session reached) BEFORE averaging. The old code summed every raw scroll event
   // and divided by session count, which inflated avgScrollDepth far past 100% (a "percent" metric
   // showing 25510) and over-counted the histogram (one bump per event instead of per session).
   const map = new Map<string, Map<string, number>>(); // page -> (session -> deepest pct reached)
   rows.forEach((row) => {
      if (row.type !== 'scroll') { return; }
      const page = (row.page || '').trim();
      const session = (row.session || '').trim();
      const pct = Math.max(0, Math.min(100, num(row.value)));
      let sessions = map.get(page);
      if (!sessions) { sessions = new Map<string, number>(); map.set(page, sessions); }
      const prev = sessions.get(session) ?? 0;
      if (pct > prev) { sessions.set(session, pct); }
   });
   const distribution: ScrollDistribution = { '0-25': 0, '25-50': 0, '50-75': 0, '75-100': 0 };
   const pages = Array.from(map.entries()).map(([page, sessions]) => {
      const depths = Array.from(sessions.values());
      let sum = 0;
      let max = 0;
      depths.forEach((d) => {
         sum += d;
         if (d > max) { max = d; }
         if (d < 25) { distribution['0-25'] += 1; }
         else if (d < 50) { distribution['25-50'] += 1; }
         else if (d < 75) { distribution['50-75'] += 1; }
         else { distribution['75-100'] += 1; }
      });
      return {
         page,
         avgScrollDepth: round1(sum / Math.max(1, depths.length)),
         maxScrollDepth: round1(max),
         sessions: depths.length,
      };
   });
   pages.sort((a, b) => b.avgScrollDepth - a.avgScrollDepth);
   return { pages, distribution };
};

// ---------------------------------------------------------------------------
// page_engagement: per-page average and total active engagement seconds.
// value on an engagement event is summed active seconds for that session/page.
// ---------------------------------------------------------------------------
export type PageEngagementRow = {
   page: string,
   avgEngagementSeconds: number,
   totalEngagementSeconds: number,
   sessions: number,
}

export const buildPageEngagement = (rows: EventRow[]): { pages: PageEngagementRow[], siteAvgEngagementSeconds: number } => {
   const map = new Map<string, { sum: number, sessions: Set<string> }>();
   let siteSum = 0;
   let siteSessions = 0;
   rows.forEach((row) => {
      if (row.type !== 'engagement') { return; }
      const page = (row.page || '').trim();
      const secs = Math.max(0, num(row.value));
      let entry = map.get(page);
      if (!entry) {
         entry = { sum: 0, sessions: new Set<string>() };
         map.set(page, entry);
      }
      entry.sum += secs;
      entry.sessions.add((row.session || '').trim());
      siteSum += secs;
   });
   const pages = Array.from(map.entries()).map(([page, entry]) => {
      const sessions = entry.sessions.size;
      siteSessions += sessions;
      return {
         page,
         avgEngagementSeconds: round1(entry.sum / Math.max(1, sessions)),
         totalEngagementSeconds: round1(entry.sum),
         sessions,
      };
   });
   pages.sort((a, b) => b.totalEngagementSeconds - a.totalEngagementSeconds);
   return { pages, siteAvgEngagementSeconds: round1(siteSum / Math.max(1, siteSessions)) };
};

// ---------------------------------------------------------------------------
// conversions_by_source: attribute conversion events (form_submit by default, or any chosen
// event type) to the session's first-touch source, so a marketer can answer "which traffic
// sources actually drive conversions" with no GA4 setup. This is the autocapture join GA4
// makes painful: s33k already stamps a first-touch source on every event at ingest, so the
// attribution is a pure group-by here, not a channel-grouping config + wait.
//
// Privacy: source is a CLASSIFICATION ('direct' | 'referral' | 'organic-search' | 'ai') or at
// most a bare referral host, sanitized at ingest; nothing identifying flows through.
//
// The optional conversion-rate-by-source uses ONLY first-party owned data: the denominator is
// the number of DISTINCT sessions that fired ANY event under each source in the same window,
// derived from the same event store. It is honestly labelled approximate, because a session
// with no autocaptured event at all is invisible to it (so the true session base per source is
// at least this large, never smaller), and the rate is conversions / event-bearing-sessions.
// ---------------------------------------------------------------------------
export type ConversionSourceRow = {
   source: string,
   count: number,
   share: number,
   conversionRate?: number | null,
}

export type ConversionsBySource = {
   event: string,
   conversions: ConversionSourceRow[],
   totalConversions: number,
   topSource: { source: string, count: number } | null,
   conversionRateNote: string | null,
}

// The label used when a row has no stored source (legacy rows captured before the source
// column existed). Matches the ingest default so the two never split a bucket.
const UNKNOWN_SOURCE = 'direct';

export const buildConversionsBySource = (rows: EventRow[], eventType = 'form_submit'): ConversionsBySource => {
   const wantType = String(eventType || 'form_submit').trim().toLowerCase() || 'form_submit';

   // Conversions per source, plus the distinct sessions seen per source across ALL events in
   // the window (the rate denominator). One pass over the rows builds both.
   const conversionsBySource = new Map<string, number>();
   const sessionsBySource = new Map<string, Set<string>>();
   let totalConversions = 0;

   rows.forEach((row) => {
      const source = (row.source || '').trim() || UNKNOWN_SOURCE;
      const session = (row.session || '').trim();
      if (session) {
         let set = sessionsBySource.get(source);
         if (!set) { set = new Set<string>(); sessionsBySource.set(source, set); }
         set.add(session);
      }
      if (String(row.type || '').toLowerCase() !== wantType) { return; }
      totalConversions += 1;
      conversionsBySource.set(source, (conversionsBySource.get(source) || 0) + 1);
   });

   // A rate is only honest where we actually have a session base for that source. When no
   // source has a usable denominator, drop the rate entirely and say why.
   let anyRate = false;
   const conversions: ConversionSourceRow[] = Array.from(conversionsBySource.entries()).map(([source, count]) => {
      const sessions = sessionsBySource.get(source)?.size ?? 0;
      const conversionRate = sessions > 0 ? round1((count / sessions) * 100) : null;
      if (conversionRate !== null) { anyRate = true; }
      return {
         source,
         count,
         share: totalConversions > 0 ? round1((count / totalConversions) * 100) : 0,
         conversionRate,
      };
   });

   conversions.sort((a, b) => b.count - a.count);
   const topSource = conversions.length > 0 ? { source: conversions[0].source, count: conversions[0].count } : null;
   const conversionRateNote = anyRate
      ? 'Approximate. conversionRate is conversions divided by the distinct sessions that fired any '
         + 'autocaptured event under that source in the window, so sessions with no event at all are not '
         + 'counted and the true base per source is at least this large (the real rate is no higher).'
      : null;

   return { event: wantType, conversions, totalConversions, topSource, conversionRateNote };
};
