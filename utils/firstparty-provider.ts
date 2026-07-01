/**
 * FirstPartyProvider: the single, owned analytics provider for the single-user OSS build.
 *
 * Every number comes from the app's OWN first-party event stream (the s33k_event table, filled by
 * the s33k.js beacon), so there is no third-party analytics SaaS to configure, no API key, and no
 * network call. This replaces the Umami and Lodd providers.
 *
 * Design: one query spine (loadRows) loads the domain's events for the window; every method derives
 * from those rows (and utils/sessionize) so the numbers can never diverge across methods. It composes
 * the already-tested first-party utils rather than re-deriving anything:
 *   - utils/sessionize.ts      per-session aggregates + human/bot split + engaged/bounce test.
 *   - utils/eventReports.ts    the shared period-cutoff grammar and click/form/scroll/engagement builders.
 *   - utils/ai-landing.ts      exact human AI-channel sessions per landing page.
 *   - utils/ai-sources.ts      referrer -> AI-engine / source-class classification.
 *   - utils/clean-path.ts      the comparable-path normalizer.
 *
 * Contract (identical to the old providers): NO method ever throws. On any error a method resolves to
 * the empty-shape result for its type with a string in the `error` field.
 *
 * Human-only default: visitor / session / entry counts filter is_bot=false to match the app's
 * human-only dashboard headline. Pageviews are reported over human sessions too (documented per
 * method) so a page's pageview count and its unique-visitor count come from the same session set.
 *
 * No server-side LLM: this is a pure, rules-based group-by over owned rows.
 */

import { Op } from 'sequelize';
import S33kEvent from '../database/models/s33kEvent';
import {
   sessionize, isBounce, isEngaged, normalizeChannel, EventLike, SessionAgg,
} from './sessionize';
import { eventPeriodCutoff, buildPageEngagement, EventRow as RawEventRow } from './eventReports';
import { aiLandingFromSessions } from './ai-landing';
import { classifyReferrer } from './ai-sources';
import { cleanPath } from './clean-path';
import {
   AnalyticsProvider,
   AnalyticsResult,
   ReferralResult,
   ReferralSource,
   SummaryResult,
   BreakdownResult,
   BreakdownDimension,
   TimeSeriesResult,
   TimeSeriesPoint,
   EventsResult,
   EventRow,
   EngagementResult,
   EngagementTier,
   EntryPagesResult,
   EntryPage,
   EntryPageSources,
   NormalizedPage,
} from './analytics';

// The raw s33k_event columns this provider reads. `id` is selected as the sessionize sort tiebreaker
// (deterministic landing/exit ordering on Postgres). All fields are read-only here; nothing mutates.
type Row = {
   id: number | string,
   type: string,
   page: string | null,
   label: string | null,
   selector: string | null,
   value: number | null,
   session: string | null,
   source: string | null,
   is_bot: boolean,
   device: string | null,
   country: string | null,
   created: string,
};

const EMPTY_ENTRY_SOURCES: EntryPageSources = { direct: 0, referral: 0, search: 0, ai: 0 };

// Turn a raw row into the shape sessionize expects. sessionize keys on session/source/is_bot/
// device/country/page/type/created and uses id as a stable tiebreaker.
const toEventLike = (rows: Row[]): EventLike[] => rows.map((r) => ({
   session: r.session || '',
   source: r.source,
   is_bot: Boolean(r.is_bot),
   device: r.device,
   country: r.country,
   page: r.page || '',
   type: r.type,
   created: r.created,
   id: r.id,
}));

// Turn a raw row into the shape eventReports' builders expect (used by getEngagement's
// page-engagement seconds).
const toReportRows = (rows: Row[]): RawEventRow[] => rows.map((r) => ({
   type: r.type,
   page: r.page,
   label: r.label,
   selector: r.selector,
   value: r.value,
   session: r.session,
   source: r.source,
   created: r.created,
}));

const round1 = (v: number): number => Math.round(v * 10) / 10;

// Map a normalized sessionize channel ('direct'|'referral'|'organic-search'|'ai') to the interface's
// four-class EntryPageSources key ('direct'|'referral'|'search'|'ai'). 'organic-search' -> 'search'.
const channelToSourceKey = (channel: string): keyof EntryPageSources => {
   if (channel === 'ai') { return 'ai'; }
   if (channel === 'organic-search') { return 'search'; }
   if (channel === 'referral') { return 'referral'; }
   return 'direct';
};

export class FirstPartyProvider implements AnalyticsProvider {
   /**
    * The single query spine every method builds on. Loads this domain's events for the window as
    * plain rows. Single-user: owner_id scoping is intentionally dropped (there is one owner). Never
    * throws: on a DB error it resolves to an empty array and lets the caller surface the message.
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window, e.g. "30d". Defaults to "30d".
    * @returns {Promise<{ rows: Row[], error: string | null }>}
    */
   // eslint-disable-next-line class-methods-use-this
   private async loadRows(domain: string, period = '30d'): Promise<{ rows: Row[], error: string | null }> {
      try {
         const cutoff = eventPeriodCutoff(period || '30d');
         const found = await S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: cutoff } },
            attributes: ['id', 'type', 'page', 'label', 'selector', 'value', 'session', 'source', 'is_bot', 'device', 'country', 'created'],
            raw: true,
         });
         return { rows: (found as unknown) as Row[], error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { rows: [], error: `First-party analytics query failed: ${message}` };
      }
   }

   /**
    * Site-wide totals for the window, all from owned rows.
    *   visitors      distinct HUMAN sessions.
    *   visits        human session count (same as visitors first-party; sessions ARE the visits).
    *   pageviews     count of type='pageview' rows in human sessions.
    *   bounceRate    100 * bounced human sessions / total human sessions.
    *   avgDuration   average active engagement seconds per human session (from engagement rows).
    *   pagesPerVisit pageviews / human sessions.
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @returns {Promise<SummaryResult>}
    */
   async getSummary(domain: string, period = '30d'): Promise<SummaryResult> {
      const empty: SummaryResult = {
         pageviews: 0, visitors: 0, visits: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null,
      };
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { ...empty, error }; }

      const sessions = sessionize(toEventLike(rows));
      const human = sessions.filter((s) => !s.isBot);
      const humanIds = new Set(human.map((s) => s.id));
      const totalSessions = human.length;
      if (totalSessions === 0) { return empty; }

      // Pageviews over human sessions only, so pageviews and visitors come from the same session set.
      const pageviews = rows.filter((r) => r.type === 'pageview' && humanIds.has(r.session || `anon-${r.created}`)).length;
      const bounced = human.reduce((n, s) => (isBounce(s) ? n + 1 : n), 0);

      // Active engagement seconds per session, from the engagement rows (the honest active-time metric,
      // not wall-clock). Summed per session, averaged over all human sessions.
      const secondsBySession = new Map<string, number>();
      rows.forEach((r) => {
         if (r.type !== 'engagement') { return; }
         const sid = r.session || `anon-${r.created}`;
         if (!humanIds.has(sid)) { return; }
         const secs = Math.max(0, typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : 0);
         secondsBySession.set(sid, (secondsBySession.get(sid) || 0) + secs);
      });
      let totalSeconds = 0;
      secondsBySession.forEach((s) => { totalSeconds += s; });

      return {
         pageviews,
         visitors: totalSessions,
         visits: totalSessions,
         bounceRate: round1((100 * bounced) / totalSessions),
         avgDuration: round1(totalSeconds / totalSessions),
         pagesPerVisit: round1(pageviews / totalSessions),
         error: null,
      };
   }

   /**
    * Per-page traffic: group human pageview rows by clean path.
    *   page_views       pageviews for the path (human sessions).
    *   unique_visitors  distinct human sessions that viewed the path.
    *   bounce_rate / avg_duration  null at page grain (the beacon does not carry per-page duration
    *                    reliably), with metricsNote so null is not read as zero.
    * page_title is omitted (the beacon captures no title).
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @returns {Promise<AnalyticsResult>}
    */
   async getPageTraffic(domain: string, period = '30d'): Promise<AnalyticsResult> {
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { pages: [], error }; }

      const sessions = sessionize(toEventLike(rows));
      const humanIds = new Set(sessions.filter((s) => !s.isBot).map((s) => s.id));

      type Agg = { url: string, views: number, sessions: Set<string> };
      const byPath = new Map<string, Agg>();
      rows.forEach((r) => {
         if (r.type !== 'pageview') { return; }
         const sid = r.session || `anon-${r.created}`;
         if (!humanIds.has(sid)) { return; }
         const raw = r.page || '';
         const key = cleanPath(raw);
         let agg = byPath.get(key);
         if (!agg) { agg = { url: raw, views: 0, sessions: new Set<string>() }; byPath.set(key, agg); }
         agg.views += 1;
         agg.sessions.add(sid);
      });

      const note = 'bounce_rate and avg_duration are unavailable at page grain in single-beacon mode.';
      const pages: NormalizedPage[] = Array.from(byPath.entries()).map(([pathClean, agg]) => ({
         url: agg.url,
         pathClean,
         page_views: agg.views,
         unique_visitors: agg.sessions.size,
         bounce_rate: null,
         avg_duration: null,
         metricsNote: note,
      }));
      pages.sort((a, b) => b.page_views - a.page_views);
      return { pages, error: null };
   }

   /**
    * Referral sources for the window, classified for AI-referral tracking.
    * Bucket human sessions by their first-touch `source` (the stored class or bare host). For each
    * bucket: unique_visitors = distinct sessions, type = the four-class label, engine/isAI from the
    * AI classifier, and (for AI sources) landing_path attached from aiLandingFromSessions, which the
    * old Umami provider could not do first-party.
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "90d".
    * @returns {Promise<ReferralResult>}
    */
   async getReferralSources(domain: string, period = '90d'): Promise<ReferralResult> {
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { sources: [], error }; }

      const eventLike = toEventLike(rows);
      const sessions = sessionize(eventLike).filter((s) => !s.isBot);

      // The exact human AI-channel landing pages, keyed by clean path (first-party, unlike Umami).
      const { byLanding } = aiLandingFromSessions(eventLike);
      // Pick the top AI landing page as the representative landing_path for AI buckets.
      let topAiLanding: string | undefined;
      let topAiCount = -1;
      byLanding.forEach((count, path) => { if (count > topAiCount) { topAiCount = count; topAiLanding = path; } });

      // sessionize normalizes each session's source to a channel and drops the original string, but
      // getReferralSources wants the raw source (a class or bare host) to classify (e.g. distinguish
      // "news.ycombinator.com" from the generic "referral" class). Build session id -> raw source in
      // ONE pass over the rows (each session's source is constant, so the first row seen wins). Empty/
      // null defaults to 'direct' to match the ingest default so it shares the direct bucket.
      const rawSourceById = new Map<string, string>();
      eventLike.forEach((r) => {
         const sid = r.session || `anon-${r.created}`;
         if (!rawSourceById.has(sid)) { rawSourceById.set(sid, (r.source || '').trim() || 'direct'); }
      });

      type Bucket = { name: string, sessions: Set<string>, pageviews: number };
      const bySource = new Map<string, Bucket>();
      sessions.forEach((s) => {
         const raw = rawSourceById.get(s.id) || 'direct';
         let b = bySource.get(raw);
         if (!b) { b = { name: raw, sessions: new Set<string>(), pageviews: 0 }; bySource.set(raw, b); }
         b.sessions.add(s.id);
         b.pageviews += s.pageviewCount;
      });

      const sources: ReferralSource[] = Array.from(bySource.values()).map((b) => {
         // The stored source is EITHER a first-touch CLASS ('ai'|'referral'|'organic-search'|'direct')
         // or a bare host. normalizeChannel handles both (a class passes through, a host -> 'referral'),
         // so the channel is the authoritative four-class type. classifyReferrer only resolves an AI
         // ENGINE NAME from a host, so it augments (a bare AI host gets both isAI + an engine label);
         // a stored 'ai' class is AI with a null engine. Mapping 'organic-search' -> the interface's
         // 'search' label keeps the ReferralSource.type vocabulary consistent with the rest of the app.
         const channel = normalizeChannel(b.name);
         const byHost = classifyReferrer(b.name);
         const isAI = channel === 'ai' || byHost.isAI;
         const type = channel === 'organic-search' ? 'search' : channel;
         const src: ReferralSource = {
            name: b.name,
            type,
            engine: byHost.engine,
            isAI,
            page_views: b.pageviews,
            unique_visitors: b.sessions.size,
         };
         if (isAI && topAiLanding) { src.landing_path = topAiLanding; }
         return src;
      });
      sources.sort((a, b) => b.unique_visitors - a.unique_visitors);
      return { sources, error: null };
   }

   /**
    * Dimensional breakdown. country and device are backed by beacon columns and return real rows.
    * browser/os/region/city/language/screen have NO beacon column in single-beacon mode and return
    * an empty row set with an honest error/note (the interface contract: never throw, unsupported
    * dimensions return empty rows).
    * @param {string} domain - The site domain.
    * @param {BreakdownDimension} dimension - Which dimension to break down by.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @returns {Promise<BreakdownResult>}
    */
   async getBreakdown(domain: string, dimension: BreakdownDimension, period = '30d'): Promise<BreakdownResult> {
      if (dimension !== 'country' && dimension !== 'device') {
         return { rows: [], error: `Dimension "${dimension}" is not available in single-beacon mode (only country and device are collected).` };
      }
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { rows: [], error }; }

      const sessions = sessionize(toEventLike(rows)).filter((s) => !s.isBot);
      const counts = new Map<string, number>();
      sessions.forEach((s) => {
         let name: string;
         if (dimension === 'country') { name = s.country || 'Unknown'; } else { name = s.device || 'Unknown'; }
         counts.set(name, (counts.get(name) || 0) + 1);
      });
      const out = Array.from(counts.entries())
         .map(([name, unique_visitors]) => ({ name, unique_visitors }))
         .sort((a, b) => b.unique_visitors - a.unique_visitors);
      return { rows: out, error: null };
   }

   /**
    * Daily time series of pageviews and visitors over the window (human sessions).
    * unit is 'day' for V1; a non-day unit falls back to day with a note in the error field is not
    * used (the interface expects data), so day-bucketing is applied regardless and documented.
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @param {string} [unit] - Bucket unit. Only "day" is supported in V1.
    * @returns {Promise<TimeSeriesResult>}
    */
   async getTimeSeries(domain: string, period = '30d', unit = 'day'): Promise<TimeSeriesResult> {
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { series: [], error }; }

      const sessions = sessionize(toEventLike(rows));
      const humanIds = new Set(sessions.filter((s) => !s.isBot).map((s) => s.id));

      // day -> { pageviews, sessions }
      const byDay = new Map<string, { pageviews: number, sessions: Set<string> }>();
      const dayOf = (iso: string): string => String(iso || '').slice(0, 10);
      rows.forEach((r) => {
         const sid = r.session || `anon-${r.created}`;
         if (!humanIds.has(sid)) { return; }
         const day = dayOf(r.created);
         if (!day) { return; }
         let bucket = byDay.get(day);
         if (!bucket) { bucket = { pageviews: 0, sessions: new Set<string>() }; byDay.set(day, bucket); }
         if (r.type === 'pageview') { bucket.pageviews += 1; }
         bucket.sessions.add(sid);
      });

      const byDate = (a: TimeSeriesPoint, b: TimeSeriesPoint): number => {
         if (a.date < b.date) { return -1; }
         if (a.date > b.date) { return 1; }
         return 0;
      };
      const series: TimeSeriesPoint[] = Array.from(byDay.entries())
         .map(([date, b]) => ({ date, pageviews: b.pageviews, visitors: b.sessions.size }))
         .sort(byDate);
      const noteError = unit && unit !== 'day' ? `Only daily buckets are supported in single-beacon mode; "${unit}" was treated as "day".` : null;
      return { series, error: noteError };
   }

   /**
    * Events for the window: non-pageview autocaptured event types with their fire counts. Grouped by
    * TYPE (click / form_submit / scroll / engagement / outbound / webvital), which matches how the
    * top_events surface consumes a { name, count } list. Pageviews are excluded (they are traffic,
    * not custom events).
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @returns {Promise<EventsResult>}
    */
   async getEvents(domain: string, period = '30d'): Promise<EventsResult> {
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { events: [], error }; }

      const counts = new Map<string, number>();
      rows.forEach((r) => {
         if (r.type === 'pageview') { return; }
         counts.set(r.type, (counts.get(r.type) || 0) + 1);
      });
      const events: EventRow[] = Array.from(counts.entries())
         .map(([name, count]) => ({ name, count }))
         .sort((a, b) => b.count - a.count);
      return { events, error: null };
   }

   /**
    * Engagement tiers (session-quality buckets) for the window. Human sessions are split into
    * bounced (single-page, no non-pageview event) and engaged (its inverse) using the shared
    * isEngaged/isBounce test, so the tiers can never disagree with getSummary's bounce rate.
    * avgDuration comes from the same active-engagement seconds getSummary uses; avgPages from
    * pageviewCount. This mirrors what the Umami provider DERIVED, so it is parity, not a downgrade.
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @returns {Promise<EngagementResult>}
    */
   async getEngagement(domain: string, period = '30d'): Promise<EngagementResult> {
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { tiers: [], error }; }

      const human = sessionize(toEventLike(rows)).filter((s) => !s.isBot);
      const total = human.length;
      if (total === 0) { return { tiers: [], error: null }; }

      const bounced = human.filter(isBounce);
      const engaged = human.filter(isEngaged);

      // Site-wide average active engagement seconds per session, reused from the shared builder so the
      // number matches page-engagement's site average.
      const { siteAvgEngagementSeconds } = buildPageEngagement(toReportRows(rows));

      const avgPages = (set: SessionAgg[]): number => (set.length > 0
         ? round1(set.reduce((n, s) => n + s.pageviewCount, 0) / set.length) : 0);
      const pct = (n: number): number => round1((100 * n) / total);

      const tiers: EngagementTier[] = [
         {
            label: 'bounced',
            sessions: bounced.length,
            percentage: pct(bounced.length),
            avgDuration: 0,
            avgPages: avgPages(bounced),
         },
         {
            label: 'engaged',
            sessions: engaged.length,
            percentage: pct(engaged.length),
            avgDuration: siteAvgEngagementSeconds,
            avgPages: avgPages(engaged),
         },
      ];
      return { tiers, error: null };
   }

   /**
    * Entry (landing) pages: where sessions START, the acquisition surface. Computed EXACTLY from
    * owned rows, so unlike the Umami provider the per-page source split is measured, not approximated
    * (sourcesApproximated=false on every page, sourcesNote=null). Human sessions with at least one
    * pageview credit their clean landing page; each page's sources are the four-class split of the
    * sessions that landed there (organic-search channel maps to the interface's 'search' key).
    * @param {string} domain - The site domain.
    * @param {string} [period] - Reporting window. Defaults to "30d".
    * @returns {Promise<EntryPagesResult>}
    */
   async getEntryPages(domain: string, period = '30d'): Promise<EntryPagesResult> {
      const empty: EntryPagesResult = {
         pages: [], siteSources: { ...EMPTY_ENTRY_SOURCES }, sourcesNote: null, error: null,
      };
      const { rows, error } = await this.loadRows(domain, period);
      if (error) { return { ...empty, error }; }

      const human = sessionize(toEventLike(rows)).filter((s) => !s.isBot && s.pageviewCount > 0);

      const siteSources: EntryPageSources = { ...EMPTY_ENTRY_SOURCES };
      const byPage = new Map<string, { page: string, entries: number, sources: EntryPageSources }>();
      human.forEach((s) => {
         const key = cleanPath(s.landingPage);
         const sourceKey = channelToSourceKey(s.channel);
         siteSources[sourceKey] += 1;
         let bucket = byPage.get(key);
         if (!bucket) { bucket = { page: s.landingPage, entries: 0, sources: { ...EMPTY_ENTRY_SOURCES } }; byPage.set(key, bucket); }
         bucket.entries += 1;
         bucket.sources[sourceKey] += 1;
      });

      const pages: EntryPage[] = Array.from(byPage.entries()).map(([pathClean, b]) => ({
         page: b.page,
         pathClean,
         entries: b.entries,
         sources: b.sources,
         // First-party: the split is measured per page from owned sessions, not estimated. Honest.
         sourcesApproximated: false,
      }));
      pages.sort((a, b) => b.entries - a.entries);
      return { pages, siteSources, sourcesNote: null, error: null };
   }
}

export default FirstPartyProvider;
