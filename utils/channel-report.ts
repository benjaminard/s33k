// Channel report: map every first-party session to a clean marketing channel a marketer thinks in
// (Organic Search / AI Search / Referral / Direct), and report sessions per channel, plus optional
// conversions when a named goal is supplied.
//
// The session's raw `channel` is already normalized to a machine code (direct / referral /
// organic-search / ai) by sessionize. This module is the pure display-mapping + roll-up: it turns
// those codes into human-facing channel names and aggregates. It also surfaces the top referring
// sources WITHIN Referral (the bare referrer hosts carried on referral sessions), since "who refers
// us" is the first follow-up question after "how much referral traffic".
//
// No server-side LLM: this returns structured rows for the user's own LLM (and the briefing) to
// narrate.

import { SessionAgg, GoalDef, sessionConverted } from './sessionize';

// The display channels, in the order a marketer reads them. Codes are the values sessionize emits on
// session.channel; labels are what we report.
export const CHANNEL_LABELS: Record<string, string> = {
   'organic-search': 'Organic Search',
   ai: 'AI Search',
   referral: 'Referral',
   direct: 'Direct',
};

// Stable display order so the report reads the same every time, regardless of which channels have
// traffic this window.
const CHANNEL_ORDER = ['organic-search', 'ai', 'referral', 'direct'];

export type ChannelReportRow = {
   channel: string, // the machine code, e.g. 'organic-search'
   label: string, // the display name, e.g. 'Organic Search'
   sessions: number,
   sessionsPct: number,
   conversions?: number, // present only when a goal was supplied
   conversionRatePct?: number, // present only when a goal was supplied
};

export type ReferralSource = { source: string, sessions: number };

export type ChannelReport = {
   totalSessions: number,
   conversions?: number, // total goal conversions across all channels (goal supplied only)
   conversionRatePct?: number,
   channels: ChannelReportRow[],
   topReferralSources: ReferralSource[], // bare referrer hosts within the Referral channel
   hasGoal: boolean,
};

const rate = (numer: number, denom: number): number => (denom > 0 ? Math.round((1000 * numer) / denom) / 10 : 0);

// A referral session carries its bare referrer HOST in source when sessionize could not classify it
// to a known channel (so source was passed through as 'referral' OR left as the raw host). We only
// count sources that are an actual host, not the literal channel codes, since "referral" itself is
// not a useful "who referred us" answer.
const KNOWN_CODES = new Set(['direct', 'referral', 'organic-search', 'ai']);

/**
 * Roll first-party sessions up into a per-channel report with clean display labels, and (when a goal
 * is given) per-channel conversions and rate. Sessions are expected pre-filtered (e.g. human-only)
 * by the caller, so this is a pure mapping/aggregation with no filtering of its own.
 * @param {SessionAgg[]} sessions - Sessionized, already-filtered first-party sessions.
 * @param {{ session: SessionAgg, source: string | null }[]} sessionSources - Each session paired
 *   with its raw stored source string, used to surface the top referrers within Referral. The raw
 *   source is needed because sessionize normalizes session.channel and does not keep the host.
 * @param {GoalDef | null} goal - Optional conversion goal. When present, conversions/rate are added.
 * @returns {ChannelReport}
 */
export const buildChannelReport = (
   sessions: SessionAgg[],
   sessionSources: { id: string, source: string | null }[],
   goal: GoalDef | null,
): ChannelReport => {
   const totalSessions = sessions.length;
   const hasGoal = Boolean(goal);

   // Bucket sessions by their normalized channel code, counting conversions only when a goal exists.
   const bucket = new Map<string, { sessions: number, conversions: number }>();
   for (const s of sessions) {
      if (!bucket.has(s.channel)) { bucket.set(s.channel, { sessions: 0, conversions: 0 }); }
      const b = bucket.get(s.channel) as { sessions: number, conversions: number };
      b.sessions += 1;
      if (goal && sessionConverted(s, goal)) { b.conversions += 1; }
   }

   // Emit channels in the stable marketer-reading order, then any unexpected codes after, so a new
   // channel code never silently disappears from the report.
   const seen = new Set<string>();
   const orderedCodes = [...CHANNEL_ORDER, ...Array.from(bucket.keys())].filter((c) => {
      if (seen.has(c)) { return false; }
      seen.add(c);
      return bucket.has(c);
   });

   const totalConversions = goal
      ? Array.from(bucket.values()).reduce((sum, b) => sum + b.conversions, 0)
      : 0;

   const channels: ChannelReportRow[] = orderedCodes.map((code) => {
      const b = bucket.get(code) as { sessions: number, conversions: number };
      const rowBase: ChannelReportRow = {
         channel: code,
         label: CHANNEL_LABELS[code] || code,
         sessions: b.sessions,
         sessionsPct: rate(b.sessions, totalSessions),
      };
      if (goal) {
         rowBase.conversions = b.conversions;
         rowBase.conversionRatePct = rate(b.conversions, b.sessions);
      }
      return rowBase;
   });

   // Top referring sources within the Referral channel. Only sessions classified 'referral' that
   // also carry a bare host (not a channel code) contribute, so this answers "which sites send us
   // referral traffic" without leaking PII (sessionize already strips paths/queries at ingest).
   const referralIds = new Set(sessions.filter((s) => s.channel === 'referral').map((s) => s.id));
   const refBucket = new Map<string, number>();
   for (const { id, source } of sessionSources) {
      if (!referralIds.has(id)) { continue; }
      const host = String(source || '').trim().toLowerCase();
      if (!host || KNOWN_CODES.has(host)) { continue; }
      refBucket.set(host, (refBucket.get(host) || 0) + 1);
   }
   const topReferralSources: ReferralSource[] = Array.from(refBucket.entries())
      .map(([source, count]) => ({ source, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 10);

   const report: ChannelReport = {
      totalSessions,
      channels,
      topReferralSources,
      hasGoal,
   };
   if (goal) {
      report.conversions = totalConversions;
      report.conversionRatePct = rate(totalConversions, totalSessions);
   }
   return report;
};
