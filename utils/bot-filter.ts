/**
 * Human vs bot traffic estimation.
 *
 * Lodd (and most analytics) overcount automated traffic: JavaScript-executing
 * scrapers run the tracking script and get counted as real visitors. Lodd's own
 * bot_report came back empty while a large share of example.com "visitors"
 * were obviously automated (heavy HK / SG / CN datacenter traffic at ~99-100%
 * bounce with near-zero time on page).
 *
 * This module is a faithful TypeScript port of the working Python heuristic in
 * lodd-traffic/traffic.py. It re-classifies traffic by BEHAVIOR, not geography:
 * scraper origins rotate, so a country allowlist would rot and would wrongly
 * drop real international humans.
 *
 * The core rule (is a segment bot-suspected?):
 *   bounce rate >= BOUNCE_MIN (~99%) AND average duration < DURATION_MAX (~15s),
 *   where a null/missing duration counts as "essentially no time on page".
 *
 * Two human-floor cross-checks override the rule, so a segment is NEVER flagged
 * as bot when either holds:
 *   1. Engaged behavior: 2+ pages or an event fired (a bouncing one-page bot
 *      cannot land here).
 *   2. Known-human referrer: visitors from search, social, AI engines, or email
 *      are treated as human regardless of bounce/duration. Scrapers arrive as
 *      "Direct"; AI engines and search are human signals.
 *
 * IMPORTANT: this is an ESTIMATE, not an exact count. It separates LIKELY humans
 * from LIKELY bots from aggregate behavior; it does not identify individual
 * sessions. Treat the numbers as directional.
 *
 * Nothing here throws. Bad/partial rows degrade to "human" (the conservative
 * choice: we never over-flag on missing data).
 */

import type { AnalyticsProvider } from './analytics';
import { humanBotSplit, SessionAgg } from './sessionize';

/**
 * Bounce threshold (percent). At or above this, the segment is "all bounce".
 * Ported from BOUNCE_MIN in lodd-traffic/traffic.py.
 */
export const BOUNCE_MIN = 99.0;

/**
 * Duration threshold (seconds). Below this (or null), the segment spent
 * essentially no time on page. Ported from DURATION_MAX in traffic.py.
 */
export const DURATION_MAX = 15.0;

/**
 * Referrer name substrings that signal a real human regardless of behavior.
 * Scrapers come in as "Direct", not from these. Ported from
 * HUMAN_REFERRER_HINTS in traffic.py. Matched case-insensitively as substrings.
 */
export const HUMAN_REFERRER_HINTS: readonly string[] = [
   'google', 'linkedin', 'chatgpt', 'openai', 'claude', 'anthropic',
   'perplexity', 'bing', 'brave', 'duckduckgo', 'mail.', 'gmail', 't.co',
   'twitter', 'x.com', 'facebook', 'reddit', 'youtube',
];

/** Source types (e.g. from the provider's classification) that are always human. */
export const HUMAN_SOURCE_TYPES: readonly string[] = ['ai', 'search', 'social', 'email'];

/**
 * A single traffic segment to classify. Models a page row, a country row, or a
 * source row. All fields are optional so any provider's rows can be passed in;
 * the heuristic only acts on what is present.
 *
 *   name             Segment label (country code, page path, or source name).
 *   unique_visitors  Visitor count for the segment. Used for the split totals.
 *   bounce_rate      Bounce rate as a percent (0..100). The bot signal.
 *   avg_duration     Average on-page time in seconds. The bot signal.
 *   isAI             Provider flag: this source is an AI engine (human floor).
 *   source_type      Provider source type ("ai", "search", "social", ...).
 *   engaged          Provider flag: segment showed 2+ pages or an event (human floor).
 */
export type BotRow = {
   name?: string,
   unique_visitors?: number,
   bounce_rate?: number | null,
   avg_duration?: number | null,
   isAI?: boolean,
   source_type?: string | null,
   engaged?: boolean,
};

/** Coerce a maybe-number to a finite number or null (treats NaN as null). */
const numOrNull = (value: number | null | undefined): number | null => {
   if (value === null || value === undefined) { return null; }
   const n = Number(value);
   return Number.isFinite(n) ? n : null;
};

/**
 * Whether a row's referrer/source counts as a known-human signal.
 * True when the provider already tagged it AI, when source_type is a known
 * human type, or when the name matches a human-referrer hint.
 * @param {BotRow} row - The segment to test.
 * @returns {boolean}
 */
export const isHumanReferrer = (row: BotRow): boolean => {
   if (row.isAI === true) { return true; }
   const stype = String(row.source_type ?? '').toLowerCase();
   if (stype && HUMAN_SOURCE_TYPES.includes(stype)) { return true; }
   const name = String(row.name ?? '').toLowerCase();
   if (name && HUMAN_REFERRER_HINTS.some((hint) => name.includes(hint))) { return true; }
   return false;
};

/**
 * Classify a single segment as bot-suspected.
 *
 * Faithful port of is_bot_segment in lodd-traffic/traffic.py, plus the two
 * human-floor cross-checks applied first. Never throws.
 *
 * Returns true only when:
 *   - the segment is NOT engaged (no 2+ pages / event), AND
 *   - the segment is NOT from a known-human referrer, AND
 *   - bounce_rate is present and >= BOUNCE_MIN, AND
 *   - avg_duration is null or < DURATION_MAX.
 *
 * A missing bounce_rate means "no behavioral evidence", so the row is treated as
 * human (returns false), matching the Python reference.
 *
 * @param {BotRow} row - The segment to classify.
 * @returns {boolean} True if the segment is bot-suspected.
 */
export const isBotSegment = (row: BotRow): boolean => {
   if (!row || typeof row !== 'object') { return false; }
   // Human floor #1: engaged behavior (2+ pages or an event) is bot-proof.
   if (row.engaged === true) { return false; }
   // Human floor #2: known-human referrers (search/social/AI/email) are human.
   if (isHumanReferrer(row)) { return false; }

   const bounce = numOrNull(row.bounce_rate);
   if (bounce === null) { return false; }
   if (bounce < BOUNCE_MIN) { return false; }
   // Bounce is ~100%; bot if essentially no time on page.
   const dur = numOrNull(row.avg_duration);
   return dur === null || dur < DURATION_MAX;
};

/** The result of splitting a set of rows into human vs bot. */
export type HumanBotSplit = {
   human: BotRow[],
   bot: BotRow[],
   humanVisitors: number,
   botVisitors: number,
   totalVisitors: number,
   botSharePct: number,
};

/** Visitor count of a row, coerced to a non-negative finite number. */
const visitorsOf = (row: BotRow): number => {
   const n = numOrNull(row?.unique_visitors);
   return n === null || n < 0 ? 0 : n;
};

/**
 * Split a set of segments into human and bot, summing unique visitors on each
 * side. Faithful port of the country-loop in lodd-traffic/traffic.py. Never
 * throws: a non-array input yields an all-zero split.
 *
 * @param {BotRow[]} rows - Segment rows (page, country, or source grain).
 * @returns {HumanBotSplit} The split, with visitor totals and bot share percent.
 */
export const splitHumanBot = (rows: BotRow[]): HumanBotSplit => {
   const safeRows = Array.isArray(rows) ? rows : [];
   const human: BotRow[] = [];
   const bot: BotRow[] = [];
   let humanVisitors = 0;
   let botVisitors = 0;

   for (const row of safeRows) {
      const v = visitorsOf(row);
      if (isBotSegment(row)) {
         bot.push(row);
         botVisitors += v;
      } else {
         human.push(row);
         humanVisitors += v;
      }
   }

   const totalVisitors = humanVisitors + botVisitors;
   const botSharePct = totalVisitors > 0
      ? Math.round((100 * botVisitors / totalVisitors) * 10) / 10
      : 0;

   return { human, bot, humanVisitors, botVisitors, totalVisitors, botSharePct };
};

/** The human-vs-bot estimate returned by the /api/human-traffic endpoint. */
export type HumanTrafficEstimate = {
   estVisitors: number,
   estHumanVisitors: number,
   estBotVisitors: number,
   /**
    * Bot share percent. ONLY meaningful when botEstimationAvailable is true. In the honest degraded
    * shape it is 0 AND botEstimationAvailable is false AND estVisitors is 0, so it never reads as a
    * real "0% bots". Kept a number (not null) so existing numeric consumers stay type-clean; the
    * botEstimationAvailable flag is the authoritative "did we actually compute a split?" signal.
    */
   botSharePct: number,
   /**
    * True when a real human-vs-bot split was computed (first-party is_bot, or the behavioral fallback).
    * False in the degraded shape, where estBotVisitors/botSharePct are 0 because we DECLINED to guess,
    * not because zero bots were found. Consumers must not read 0 bots as "no bots" when this is false.
    */
   botEstimationAvailable: boolean,
   method: string,
   error: string | null,
};

/** Method string for the authoritative first-party split. No provider/vendor name. */
const FIRST_PARTY_METHOD = 'First-party tracking: each session\'s source IP is classified as datacenter-or-not at ingest '
   + '(the is_bot signal a JavaScript pageview tracker cannot see), so JavaScript-executing cloud scrapers are filtered '
   + 'instead of counted. Exact for the first-party sessions it has, not a heuristic over provider-reported metrics.';

/** Method string for the behavioral fallback (used only when a provider exposes page-grain bounce). */
const BEHAVIORAL_METHOD = `Behavioral estimate from the active analytics provider: bounce>=${BOUNCE_MIN}% AND `
   + `avgDuration<${DURATION_MAX}s over page rows, with a known-human referrer floor (search/social/AI/email). `
   + 'Estimate, not exact: separates likely humans from likely bots by behavior, not per-session.';

/** Method string for the honest degraded shape: no signal at all, so we decline to guess. */
const DEGRADED_METHOD = 'No first-party sessions yet and the active analytics provider exposes no page-level bounce, '
   + 'so a human-vs-bot split cannot be computed. Install the s33k.js tracking script so first-party IP-classified '
   + 'sessions flow in. Bot numbers are deliberately omitted rather than guessed.';

/**
 * Build the human-vs-bot estimate from the FIRST-PARTY is_bot tally (the authoritative path).
 * Shares the single source of truth in utils/sessionize.ts (humanBotSplit), so this matches
 * human_analytics, start_here, and the dashboard headline exactly. Never throws.
 *
 * @param {SessionAgg[]} sessions - Sessionized first-party sessions for the domain+window.
 * @returns {HumanTrafficEstimate}
 */
export const firstPartyHumanTraffic = (sessions: SessionAgg[]): HumanTrafficEstimate => {
   const split = humanBotSplit(sessions);
   return {
      estVisitors: split.total,
      estHumanVisitors: split.human,
      estBotVisitors: split.bot,
      botSharePct: split.botSharePct,
      botEstimationAvailable: true,
      method: FIRST_PARTY_METHOD,
      error: null,
   };
};

/**
 * Build a human-vs-bot estimate for a domain over a window.
 *
 * Source of truth, in order:
 *   1. FIRST-PARTY is_bot split. When sessionized first-party sessions are supplied (and non-empty),
 *      this is authoritative: the IP-classified is_bot tally, identical to human_analytics / start_here
 *      / the dashboard headline. No heuristic, no fabricated 0-bots.
 *   2. BEHAVIORAL FALLBACK. Only runs when the data actually exposes page-grain bounce (page rows carry a
 *      non-null bounce_rate). The first-party provider returns null bounce at page grain, so this path is
 *      correctly SKIPPED (the old bug was running this path anyway and short-circuiting every row to
 *      "human", reporting 0 bots / 100% human).
 *   3. HONEST DEGRADED SHAPE. When neither signal exists, return botEstimationAvailable false (with
 *      estVisitors/estBotVisitors/botSharePct all 0) rather than inventing a real "0 bots / 100% human".
 *      estBotVisitors 0 here means "declined to guess", not "no bots found"; the flag says which it is,
 *      and estVisitors 0 keeps existing estVisitors-gated consumers (briefing, insights) from printing it.
 *
 * Never throws: provider errors are surfaced in `error`; missing data degrades honestly.
 *
 * @param {AnalyticsProvider} provider - The active analytics provider.
 * @param {string} domain - The site domain, e.g. "example.com".
 * @param {string} [period] - Reporting window hint, e.g. "30d".
 * @param {SessionAgg[]} [firstPartySessions] - Sessionized first-party sessions; the authoritative split.
 * @returns {Promise<HumanTrafficEstimate>}
 */
export const estimateHumanTraffic = async (
   provider: AnalyticsProvider,
   domain: string,
   period = '30d',
   firstPartySessions?: SessionAgg[],
): Promise<HumanTrafficEstimate> => {
   // Path 1: first-party is_bot split (authoritative, one source of truth with the other views).
   if (Array.isArray(firstPartySessions) && firstPartySessions.length > 0) {
      return firstPartyHumanTraffic(firstPartySessions);
   }

   try {
      const [summary, traffic, referrals] = await Promise.all([
         provider.getSummary(domain, period),
         provider.getPageTraffic(domain, period),
         provider.getReferralSources(domain, period),
      ]);

      const errors = [summary.error, traffic.error, referrals.error].filter(Boolean) as string[];
      const error = errors.length ? errors.join('; ') : null;

      // Does the data actually expose page-grain bounce? The first-party provider returns null bounce at
      // page grain, so the behavioral heuristic has nothing to act on and must NOT run (it would fabricate
      // 0 bots).
      const pages = traffic.pages || [];
      const hasPageBounce = pages.some((p) => typeof p.bounce_rate === 'number' && Number.isFinite(p.bounce_rate));

      if (!hasPageBounce) {
         // Path 3: no first-party sessions AND no provider bounce. Decline to guess, honestly.
         // estVisitors is 0 here (not summary.visitors): a split could not be computed, and reporting a
         // visitor total beside botEstimationAvailable:false would invite consumers to imply "0 bots of N".
         // Downstream callers gate their bot lines on estVisitors > 0, so 0 cleanly omits the caveat.
         return {
            estVisitors: 0,
            estHumanVisitors: 0,
            estBotVisitors: 0,
            botSharePct: 0,
            botEstimationAvailable: false,
            method: DEGRADED_METHOD,
            error,
         };
      }

      // Path 2: behavioral fallback over page rows that DO carry bounce_rate / avg_duration.
      const pageRows: BotRow[] = pages.map((p) => ({
         name: p.pathClean || p.url,
         unique_visitors: typeof p.unique_visitors === 'number' ? p.unique_visitors : 0,
         bounce_rate: typeof p.bounce_rate === 'number' ? p.bounce_rate : null,
         avg_duration: typeof p.avg_duration === 'number' ? p.avg_duration : null,
      }));
      const pageSplit = splitHumanBot(pageRows);
      const pageBotShare = pageSplit.totalVisitors > 0
         ? pageSplit.botVisitors / pageSplit.totalVisitors
         : 0;

      // Known-human floor: visitors from AI / search / social / email sources.
      const humanFloor = (referrals.sources || [])
         .filter((s) => isHumanReferrer({ name: s.name, isAI: s.isAI, source_type: s.type }))
         .reduce((sum, s) => sum + (Number.isFinite(s.unique_visitors) ? Math.max(0, s.unique_visitors) : 0), 0);

      // Project the page-level bot share onto the site-wide visitor total.
      const rawVisitors = Number.isFinite(summary.visitors) ? Math.max(0, summary.visitors) : 0;
      const maxBots = Math.max(0, rawVisitors - humanFloor);
      const estBotVisitors = Math.min(maxBots, Math.round(rawVisitors * pageBotShare));
      const estHumanVisitors = Math.max(0, rawVisitors - estBotVisitors);
      const botSharePct = rawVisitors > 0
         ? Math.round((100 * estBotVisitors / rawVisitors) * 10) / 10
         : 0;

      return {
         estVisitors: rawVisitors,
         estHumanVisitors,
         estBotVisitors,
         botSharePct,
         botEstimationAvailable: true,
         method: BEHAVIORAL_METHOD,
         error,
      };
   } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
         estVisitors: 0,
         estHumanVisitors: 0,
         estBotVisitors: 0,
         botSharePct: 0,
         botEstimationAvailable: false,
         method: DEGRADED_METHOD,
         error: `Error estimating human traffic: ${message}`,
      };
   }
};
