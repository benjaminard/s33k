// Campaign report: group first-party sessions by their UTM campaign (utm_campaign), and report
// sessions per campaign, plus a breakdown by utm_source and utm_medium. When a named goal is
// supplied, per-campaign conversions and conversion rate are added so a marketer sees, in one view,
// which campaign sends traffic AND which campaign actually converts.
//
// The UTM tags are stamped on every event row at ingest (utm_source / utm_medium / utm_campaign /
// utm_term / utm_content), carried first-touch per session. This module is the pure aggregation: it
// takes the session aggregates paired with their first-touch UTM tags and rolls them up. Sessions
// with NO utm_campaign are grouped under a single "(none)" bucket so untagged traffic is visible and
// the totals always reconcile.
//
// No server-side LLM: this returns structured rows for the user's own LLM (and the briefing) to
// narrate.

import { SessionAgg, GoalDef, sessionConverted } from './sessionize';

// The bucket key used for sessions that carry no utm_campaign. A visible label (not an empty string)
// so untagged traffic shows up as its own row instead of vanishing, and the campaign totals reconcile
// against the channel/traffic totals.
export const NO_CAMPAIGN = '(none)';

// First-touch UTM tags for one session, paired by session id. Any tag may be null/absent.
export type SessionUtm = {
   id: string,
   utm_source: string | null,
   utm_medium: string | null,
   utm_campaign: string | null,
};

export type CampaignRow = {
   campaign: string, // the utm_campaign value, or '(none)' for untagged sessions
   sessions: number,
   sessionsPct: number,
   conversions?: number, // present only when a goal was supplied
   conversionRatePct?: number, // present only when a goal was supplied
};

export type DimensionRow = {
   value: string, // a utm_source or utm_medium value, or '(none)' when absent
   sessions: number,
};

export type CampaignReport = {
   totalSessions: number,
   conversions?: number, // total goal conversions across all campaigns (goal supplied only)
   conversionRatePct?: number,
   campaigns: CampaignRow[],
   bySource: DimensionRow[], // session counts by utm_source
   byMedium: DimensionRow[], // session counts by utm_medium
   hasGoal: boolean,
};

const rate = (numer: number, denom: number): number => (denom > 0 ? Math.round((1000 * numer) / denom) / 10 : 0);

// Stable string compare for tie-breaking sorts (avoids nested ternaries in sort callbacks).
const cmpStr = (a: string, b: string): number => {
   if (a < b) { return -1; }
   if (a > b) { return 1; }
   return 0;
};

// Normalize a stored UTM value into a bucket key. Empty/absent collapses to the shared '(none)'
// label so untagged sessions are counted, not dropped. Trimmed and lowercased so "Spring" and
// "spring " do not split into two rows.
const utmKey = (value: string | null | undefined): string => {
   const v = String(value || '').trim().toLowerCase();
   return v || NO_CAMPAIGN;
};

// Roll sessions up by one UTM dimension (source or medium), returning rows sorted by sessions desc
// then key asc (stable). A pure single-dimension count used for the bySource / byMedium breakdowns.
const rollDimension = (
   sessions: SessionAgg[],
   utmById: Map<string, SessionUtm>,
   pick: (u: SessionUtm | undefined) => string | null,
): DimensionRow[] => {
   const bucket = new Map<string, number>();
   for (const s of sessions) {
      const key = utmKey(pick(utmById.get(s.id)));
      bucket.set(key, (bucket.get(key) || 0) + 1);
   }
   return Array.from(bucket.entries())
      .map(([value, count]) => ({ value, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions || cmpStr(a.value, b.value))
      .slice(0, 50);
};

/**
 * Group first-party sessions by utm_campaign, with breakdowns by utm_source and utm_medium, and
 * (when a goal is given) per-campaign conversions and rate. Sessions are expected pre-filtered (e.g.
 * human-only) by the caller, so this is a pure mapping/aggregation with no filtering of its own.
 * @param {SessionAgg[]} sessions - Sessionized, already-filtered first-party sessions.
 * @param {SessionUtm[]} sessionUtms - Each session paired with its first-touch UTM tags. Needed
 *   because sessionize does not carry UTM tags on the SessionAgg; they live on the event rows.
 * @param {GoalDef | null} goal - Optional conversion goal. When present, conversions/rate are added.
 * @returns {CampaignReport}
 */
export const buildCampaignReport = (
   sessions: SessionAgg[],
   sessionUtms: SessionUtm[],
   goal: GoalDef | null,
): CampaignReport => {
   const totalSessions = sessions.length;
   const hasGoal = Boolean(goal);

   const utmById = new Map<string, SessionUtm>();
   for (const u of sessionUtms) { utmById.set(u.id, u); }

   // Bucket sessions by their utm_campaign key, counting conversions only when a goal exists.
   const bucket = new Map<string, { sessions: number, conversions: number }>();
   for (const s of sessions) {
      const key = utmKey(utmById.get(s.id)?.utm_campaign);
      if (!bucket.has(key)) { bucket.set(key, { sessions: 0, conversions: 0 }); }
      const b = bucket.get(key) as { sessions: number, conversions: number };
      b.sessions += 1;
      if (goal && sessionConverted(s, goal)) { b.conversions += 1; }
   }

   const totalConversions = goal
      ? Array.from(bucket.values()).reduce((sum, b) => sum + b.conversions, 0)
      : 0;

   // Named campaigns first (sorted by sessions desc), with the '(none)' untagged bucket always last
   // so it never outranks a real campaign in the reading order regardless of volume.
   const campaigns: CampaignRow[] = Array.from(bucket.entries())
      .map(([campaign, v]) => {
         const rowBase: CampaignRow = {
            campaign,
            sessions: v.sessions,
            sessionsPct: rate(v.sessions, totalSessions),
         };
         if (goal) {
            rowBase.conversions = v.conversions;
            rowBase.conversionRatePct = rate(v.conversions, v.sessions);
         }
         return rowBase;
      })
      .sort((a, b) => {
         if (a.campaign === NO_CAMPAIGN) { return 1; }
         if (b.campaign === NO_CAMPAIGN) { return -1; }
         return b.sessions - a.sessions || cmpStr(a.campaign, b.campaign);
      })
      .slice(0, 50);

   const bySource = rollDimension(sessions, utmById, (u) => u?.utm_source ?? null);
   const byMedium = rollDimension(sessions, utmById, (u) => u?.utm_medium ?? null);

   const report: CampaignReport = {
      totalSessions,
      campaigns,
      bySource,
      byMedium,
      hasGoal,
   };
   if (goal) {
      report.conversions = totalConversions;
      report.conversionRatePct = rate(totalConversions, totalSessions);
   }
   return report;
};
