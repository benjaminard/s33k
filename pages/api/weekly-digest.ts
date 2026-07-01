import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import Goal from '../../database/models/goal';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import {
   sessionize, applyFilters, EventLike, GoalDef, SessionAgg,
} from '../../utils/sessionize';
import { attributeConversions, AttribKeyword, Opportunity } from '../../utils/conversion-attribution';
import { computeRankMovers, MoverInput, RankMover } from '../../utils/rank-movers';
import * as reportCache from '../../utils/report-cache';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. ANALYSIS RUNS IN THE USER'S OWN LLM.
 * ============================================================================
 * This route does NOT call any LLM. It composes existing s33k utilities
 * (sessionize, attributeConversions, computeRankMovers) over the caller's own
 * tenant-scoped data and returns a structured, narration-ready "week in review"
 * bundle for the USER's own LLM to narrate. No embed, no fine-tune, no model
 * provider call. Full trust documentation: SECURITY.md / the security_facts tool.
 * ============================================================================
 */

// GET /api/weekly-digest?domain=&period=7d[&goal=|&goalId=][&includeBots=true]
//
// A PREBUILT REPORT (one tool that bundles existing signals into one sectioned response). It does
// NOT call other API routes over HTTP: it reuses the sessionize / conversion-attribution / rank-mover
// utilities and queries the models directly. The "week in review" sections:
//   - traffic: human visitors, pageviews, bounce (from sessionized first-party events).
//   - topEntryPages: the top 5 landing pages by entries.
//   - channels: sessions per acquisition channel.
//   - conversions: total + rate for a named goal (only when goal/goalId is supplied).
//   - rankMovers: tracked keywords that improved or worsened most over the window (parsing each
//     keyword's history JSON for the in-window delta).
//   - aiTraffic: count of sessions whose channel is AI search.
//   - topOpportunity: the single top "money move" from attributeConversions (goal supplied only).
// Human-only by default (the honest figure); pass includeBots=true to fold datacenter/bot back in.

type TrafficSection = { humanVisitors: number, pageviews: number, bounceRatePct: number, botVisitorsFiltered: number };
type EntryPageRow = { page: string, entries: number };
type ChannelRow = { channel: string, sessions: number };
type ConversionsSection = { goal: { id: number, name: string }, total: number, conversionRatePct: number } | null;

type WeeklyDigestResponse = {
   domain?: string,
   period?: string,
   traffic?: TrafficSection,
   topEntryPages?: EntryPageRow[],
   channels?: ChannelRow[],
   conversions?: ConversionsSection,
   rankMovers?: { improved: RankMover[], worsened: RankMover[] },
   aiTraffic?: { sessions: number },
   topOpportunity?: Opportunity | null,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<WeeklyDigestResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error: error || 'Not authorized' }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getWeeklyDigest(req, res, account);
}

const getWeeklyDigest = async (req: NextApiRequest, res: NextApiResponse<WeeklyDigestResponse>, account?: Account | null) => {
   const q = req.query;
   if (!q.domain || typeof q.domain !== 'string') { return res.status(400).json({ error: 'Domain is Required!' }); }
   const domain = q.domain as string;
   // A "week in review" defaults to 7d (the point of the report); any period string still works.
   const period = (typeof q.period === 'string' && q.period) ? q.period : '7d';
   const includeBots = q.includeBots === 'true';

   // Ownership gate BEFORE any pillar read. With MULTI_TENANT off this is just an existence check;
   // with it on a tenant can only digest a domain they own (the domain column is globally unique, so
   // by-domain scoping below cannot leak across tenants).
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   // Cache only AFTER the ownership check: the key is tenant-scoped (begins with the resolved
   // account ID), so a HIT can only ever return this caller's own prior result. fresh=1 / nocache=1
   // skip the read and recompute, then refill the slot.
   const cacheKey = reportCache.buildReportCacheKey('weekly-digest', req, account);
   if (!reportCache.wantsFresh(req)) {
      const hit = reportCache.get(cacheKey) as WeeklyDigestResponse | undefined;
      if (hit) { return res.status(200).json(hit); }
   }

   try {
      const nowMs = Date.now();
      const startMs = periodStartMs(period, nowMs);
      const startISO = new Date(startMs).toJSON();

      // Optionally resolve a goal (by id or name). The goal sections are OPTIONAL: with no goal the
      // digest still returns traffic / entry pages / channels / rank movers / AI traffic.
      const goalRequested = (typeof q.goalId === 'string' && q.goalId.trim()) || (typeof q.goal === 'string' && q.goal.trim());
      let goalRow: { ID: number, name: string, def: GoalDef } | null = null;
      if (goalRequested) {
         const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
         if (typeof q.goalId === 'string' && q.goalId.trim()) {
            // Validate BEFORE building the where clause: a non-numeric goalId yields NaN, and on
            // Postgres `WHERE "ID" = NaN` throws and is swallowed into a generic 400. Fail clearly.
            const gid = parseInt(q.goalId, 10);
            if (Number.isNaN(gid)) { return res.status(400).json({ error: 'goalId must be numeric' }); }
            goalWhere.ID = gid;
         } else {
            goalWhere.name = String(q.goal).trim();
         }
         const found = await Goal.findOne({ where: goalWhere });
         if (!found) { return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or omit the goal.' }); }
         const g = found.get({ plain: true }) as Record<string, unknown>;
         goalRow = {
            ID: g.ID as number,
            name: String(g.name),
            def: {
               kind: g.kind === 'event' ? 'event' : 'page_reached',
               matchValue: String(g.match_value),
               matchPage: (g.match_page as string) || null,
               matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
            },
         };
      }

      // Pull the event stream and tracked keywords in parallel. Both are scoped by owner_id.
      const [eventRows, keywordRows] = await Promise.all([
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }),
         Keyword.findAll({
            where: { domain, ...scopeWhere(account) },
            attributes: ['keyword', 'position', 'target_page', 'history'],
         }),
      ]);

      const allSessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike));
      const botVisitors = allSessions.filter((s) => s.isBot).length;

      // Human-only by default; conversions and channels read the SAME filtered base so every section
      // tells one consistent story for the window.
      const filtered: SessionAgg[] = applyFilters(allSessions, { humanOnly: !includeBots });
      // Traffic metrics are pageview-based (a session with no pageview is not a real page visit).
      const sessions = filtered.filter((s) => s.pageviewCount > 0);

      // --- traffic --------------------------------------------------------------------------------
      const humanVisitors = sessions.length;
      const pageviews = sessions.reduce((sum, s) => sum + s.pageviewCount, 0);
      const bounced = sessions.filter((s) => s.pageviewCount === 1).length;
      const bounceRatePct = humanVisitors > 0 ? Math.round((1000 * bounced) / humanVisitors) / 10 : 0;

      // --- topEntryPages (top 5 landing pages by entries) -----------------------------------------
      const entryCounts = new Map<string, number>();
      for (const s of sessions) { entryCounts.set(s.landingPage, (entryCounts.get(s.landingPage) || 0) + 1); }
      const topEntryPages: EntryPageRow[] = Array.from(entryCounts.entries())
         .map(([page, entries]) => ({ page, entries }))
         .sort((a, b) => b.entries - a.entries)
         .slice(0, 5);

      // --- channels (sessions per acquisition channel) --------------------------------------------
      const channelCounts = new Map<string, number>();
      for (const s of sessions) { channelCounts.set(s.channel, (channelCounts.get(s.channel) || 0) + 1); }
      const channels: ChannelRow[] = Array.from(channelCounts.entries())
         .map(([channel, sessCount]) => ({ channel, sessions: sessCount }))
         .sort((a, b) => b.sessions - a.sessions);

      // --- aiTraffic (count of AI-channel sessions) -----------------------------------------------
      const aiSessions = sessions.filter((s) => s.channel === 'ai').length;

      // --- rankMovers (parse each keyword's history JSON for the in-window rank delta) -------------
      const moverInputs: MoverInput[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return {
            keyword: String(p.keyword),
            history: typeof p.history === 'string' ? p.history : JSON.stringify(p.history || {}),
            currentPosition: Number(p.position) || 0,
            targetPage: String(p.target_page || ''),
         };
      });
      const movers = computeRankMovers(moverInputs, startMs, nowMs);

      // --- conversions + topOpportunity (goal supplied only) --------------------------------------
      // Reuse attributeConversions so the digest's conversion total/rate and the surfaced money-move
      // match the dedicated conversion-attribution tool exactly (no divergent second implementation).
      let conversions: ConversionsSection = null;
      let topOpportunity: Opportunity | null = null;
      if (goalRow) {
         const keywords: AttribKeyword[] = moverInputs.map((m) => ({
            keyword: m.keyword,
            position: m.currentPosition,
            targetPage: m.targetPage || '',
         }));
         const attribution = attributeConversions(sessions, goalRow.def, keywords);
         conversions = {
            goal: { id: goalRow.ID, name: goalRow.name },
            total: attribution.conversions,
            conversionRatePct: attribution.conversionRatePct,
         };
         topOpportunity = attribution.opportunities[0] || null;
      }

      const note = humanVisitors === 0
         ? 'No first-party human pageviews in this window yet. Install the s33k.js tracking script so the weekly '
            + 'digest can report traffic, channels, conversions, and AI-search visitors.'
         : `Week in review for ${domain} over ${period}. Human-only by default (${botVisitors} bot visitor(s) excluded; `
            + `pass includeBots=true for raw). ${goalRow ? `Conversions for "${goalRow.name}" included.` : 'Pass a goal to add conversions.'}`;

      const payload: WeeklyDigestResponse = {
         domain,
         period,
         traffic: {
            humanVisitors,
            pageviews,
            bounceRatePct,
            botVisitorsFiltered: includeBots ? 0 : botVisitors,
         },
         topEntryPages,
         channels,
         conversions,
         rankMovers: { improved: movers.improved, worsened: movers.worsened },
         aiTraffic: { sessions: aiSessions },
         topOpportunity,
         note,
         error: null,
      };
      // Only successful reports are cached (error/empty responses return before here).
      reportCache.set(cacheKey, payload);
      return res.status(200).json(payload);
   } catch (error) {
      console.log('[ERROR] Building Weekly Digest for ', domain, error);
      return res.status(400).json({ error: 'Error Building Weekly Digest for this Domain.' });
   }
};
