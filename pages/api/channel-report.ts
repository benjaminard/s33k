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
import { buildChannelReport, ChannelReport } from '../../utils/channel-report';

// GET /api/channel-report?domain=&period=&goal=|goalId=&includeBots=
//
// Map every first-party session to a clean marketing channel (Organic Search / AI Search / Referral
// / Direct) and report sessions per channel. When a goal is supplied, add conversions + rate per
// channel so a marketer can see, in one view, which channel sends traffic AND which channel converts.
// Also surfaces the top referring sources WITHIN the Referral channel. Human-only by default; set
// includeBots=true to fold datacenter/bot sessions back in.

type ChannelReportResponse = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   report?: ChannelReport,
   botSessionsExcluded?: number,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<ChannelReportResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getChannelReport(req, res, account);
}

const getChannelReport = async (req: NextApiRequest, res: NextApiResponse<ChannelReportResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Ownership gate first: a domain belongs to exactly one account, so this scopes the whole report.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // The goal is OPTIONAL here. With a goal we add per-channel conversions; without one the report
      // is sessions-per-channel only. A bad/missing goal name 404s rather than silently dropping it.
      let goal: GoalDef | null = null;
      let goalMeta: { id: number, name: string } | null = null;
      const hasGoalArg = (typeof q.goal === 'string' && q.goal.trim()) || (typeof q.goalId === 'string' && q.goalId.trim());
      if (hasGoalArg) {
         const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
         if (typeof q.goalId === 'string' && q.goalId.trim()) {
            goalWhere.ID = parseInt(q.goalId, 10);
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
      // etc.) without changing the channel-rollup math.
      const includeBots = q.includeBots === 'true';
      const filters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      // Load every event in the window (human + bot, so the bot exclusion can be reported), then
      // sessionize. source is needed for the per-Referral top-source roll-up.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const plainRows = rows.map((r) => r.get({ plain: true }) as EventLike);
      const allSessions = sessionize(plainRows);
      const botSessionsExcluded = filters.humanOnly ? allSessions.filter((s) => s.isBot).length : 0;

      const sessions = applyFilters(allSessions, filters);

      // One raw source per session id (first-touch), so the top-referral roll-up counts each session
      // once. sessionize uses the first event's source per session, so the first row per session wins.
      const sourceById = new Map<string, string | null>();
      for (const r of plainRows) {
         const key = r.session || `anon-${r.created}`;
         if (!sourceById.has(key)) { sourceById.set(key, r.source); }
      }
      const sessionSources = sessions.map((s) => ({ id: s.id, source: sourceById.get(s.id) ?? null }));

      const report = buildChannelReport(sessions, sessionSources, goal);

      const note = report.totalSessions === 0
         ? 'No first-party sessions in this window/filter yet. Install the s33k.js tracking script so traffic flows in.'
         : `${report.totalSessions} session(s) across ${report.channels.length} channel(s). Human-only by default`
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
      console.log('[ERROR] Building Channel Report for ', domain, error);
      return res.status(400).json({ error: 'Error Building Channel Report for this Domain.' });
   }
};
