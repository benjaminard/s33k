import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, applyFilters, parseSegmentFilters, EventLike, GoalDef } from '../../utils/sessionize';
import { buildCampaignReport, CampaignReport, SessionUtm } from '../../utils/campaign-report';

// GET /api/campaign-report?domain=&period=&goal=|goalId=&includeBots=
//
// Group every first-party session by its UTM campaign (utm_campaign) and report sessions per
// campaign, plus a breakdown by utm_source and utm_medium. When a goal is supplied, add conversions
// + rate per campaign so a marketer sees, in one view, which campaign sends traffic AND which
// campaign converts. Sessions with no utm_campaign roll into a single "(none)" bucket so untagged
// traffic stays visible and totals reconcile. Human-only by default; set includeBots=true to fold
// datacenter/bot sessions back in.

// The UTM tags are first-touch per session: parsed from the landing URL once and carried on every
// event in the batch. We read them with attributes below and take the first row's tags per session.

type CampaignReportResponse = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   report?: CampaignReport,
   botSessionsExcluded?: number,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<CampaignReportResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getCampaignReport(req, res, account);
}

const getCampaignReport = async (req: NextApiRequest, res: NextApiResponse<CampaignReportResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Ownership gate first: a domain belongs to exactly one account, so this scopes the whole report.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // The goal is OPTIONAL here. With a goal we add per-campaign conversions; without one the
      // report is sessions-per-campaign only. A bad/missing goal name 404s rather than silently
      // dropping it (same contract as channel-report).
      let goal: GoalDef | null = null;
      let goalMeta: { id: number, name: string } | null = null;
      const hasGoalArg = (typeof q.goal === 'string' && q.goal.trim()) || (typeof q.goalId === 'string' && q.goalId.trim());
      if (hasGoalArg) {
         const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
         if (typeof q.goalId === 'string' && q.goalId.trim()) {
            const gid = parseInt(q.goalId, 10);
            if (!Number.isFinite(gid)) { return res.status(400).json({ error: 'goalId must be a number.' }); }
            goalWhere.ID = gid;
         } else if (typeof q.goal === 'string' && q.goal.trim()) {
            goalWhere.name = q.goal.trim();
         }
         const goalRow = await Goal.findOne({ where: goalWhere });
         if (!goalRow) {
            return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or list goals.' });
         }
         const g = goalRow.get({ plain: true }) as Record<string, unknown>;
         goal = {
            kind: g.kind === 'event' ? 'event' : 'page_reached',
            matchValue: String(g.match_value),
            matchPage: (g.match_page as string) || null,
            matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
         };
         goalMeta = { id: g.ID as number, name: String(g.name) };
      }

      // Human-only by default. parseSegmentFilters lets callers narrow further (channel, device,
      // etc.) without changing the campaign-rollup math.
      const includeBots = q.includeBots === 'true';
      const filters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      // Load every event in the window (human + bot, so the bot exclusion can be reported), then
      // sessionize. The utm_* columns are needed for the per-campaign and per-dimension roll-ups.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created',
            'utm_source', 'utm_medium', 'utm_campaign'],
         order: [['created', 'ASC']],
      });
      const plainRows = rows.map((r) => r.get({ plain: true }) as EventLike & {
         utm_source: string | null, utm_medium: string | null, utm_campaign: string | null,
      });
      const allSessions = sessionize(plainRows);
      const botSessionsExcluded = filters.humanOnly ? allSessions.filter((s) => s.isBot).length : 0;

      const sessions = applyFilters(allSessions, filters);

      // One first-touch UTM tuple per session id, so each session contributes its first row's tags.
      // sessionize keys sessions the same way (session || `anon-${created}`). Correctness here does
      // not rely on row-order parity with sessionize (it orders by created ASC; sessionize sorts
      // created then id): UTM is session-constant, stamped identically on every row of a session at
      // ingest, so any row of the session yields the same tags.
      const utmById = new Map<string, SessionUtm>();
      for (const r of plainRows) {
         const key = r.session || `anon-${r.created}`;
         if (!utmById.has(key)) {
            utmById.set(key, { id: key, utm_source: r.utm_source ?? null, utm_medium: r.utm_medium ?? null, utm_campaign: r.utm_campaign ?? null });
         }
      }
      const sessionUtms = sessions.map((s) => utmById.get(s.id) ?? { id: s.id, utm_source: null, utm_medium: null, utm_campaign: null });

      const report = buildCampaignReport(sessions, sessionUtms, goal);

      const note = report.totalSessions === 0
         ? 'No first-party sessions in this window/filter yet. Install the s33k.js tracking script so traffic flows in.'
         : `${report.totalSessions} session(s) across ${report.campaigns.length} campaign bucket(s). Human-only by default`
            + `${botSessionsExcluded ? ` (${botSessionsExcluded} bot session(s) excluded)` : ''}`
            + `${goalMeta ? `. Conversions shown for "${goalMeta.name}"` : ''}.`;

      return res.status(200).json({
         domain,
         period,
         goal: goalMeta,
         report,
         botSessionsExcluded,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Campaign Report for ', domain, error);
      return res.status(400).json({ error: 'Error Building Campaign Report for this Domain.' });
   }
};
