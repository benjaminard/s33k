import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, applyFilters, parseSegmentFilters, EventLike, GoalDef } from '../../utils/sessionize';
import { buildEntryPageReport, EntryKeyword, EntryPageReport } from '../../utils/entry-page-report';

// GET /api/entry-page-report?domain=&period=&goal=|goalId=&includeBots=[&filters]
//
// The entry-page acquisition lens: segment first-party traffic by the LANDING (entry) page where a
// session starts, not by raw pageviews. For each entry page it joins first-touch sessions broken
// down by source channel (direct / referral / organic-search / ai), optional goal conversions+rate,
// and the tracked keywords/rank whose target page is that entry page. This connects "we rank for X"
// to "X actually lands people", the missing attribution link most analytics tools never make. Two
// gaps fall out of the data: ranking-without-landing (a ranking page with zero entries) and
// landing-without-ranking (an entry page that pulls sessions but holds no tracked keywords).
//
// Human-only by default (datacenter bots excluded); set includeBots=true to fold them in. The goal
// is OPTIONAL: omit it for the pure acquisition view, pass it to add conversion columns per page.

type Resp = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   report?: EntryPageReport,
   botSessionsExcluded?: number,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getEntryPageReport(req, res, account);
}

const getEntryPageReport = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Ownership gate first: the domain column is globally unique, so by-domain scoping cannot leak
   // across tenants. 403 before any pillar read.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // Goal is optional here. Resolve it (scoped) only when the caller asked for conversion columns;
      // a bad goal name 404s so the caller knows, rather than silently dropping the conversion view.
      let goal: GoalDef | null = null;
      let goalMeta: { id: number, name: string } | null = null;
      if ((typeof q.goal === 'string' && q.goal.trim()) || (typeof q.goalId === 'string' && q.goalId.trim())) {
         const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
         if (typeof q.goalId === 'string' && q.goalId.trim()) {
            // Reject a non-numeric goalId with a clear 400 (matching conversion-attribution.ts and
            // aeo-roi.ts) rather than passing NaN into the query, which Postgres surfaces as a generic 400.
            const gid = parseInt(q.goalId, 10);
            if (!Number.isFinite(gid)) { return res.status(400).json({ error: 'goalId must be a number.' }); }
            goalWhere.ID = gid;
         } else {
            goalWhere.name = (q.goal as string).trim();
         }
         const goalRow = await Goal.findOne({ where: goalWhere });
         if (!goalRow) { return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or list goals.' }); }
         const g = goalRow.get({ plain: true }) as Record<string, unknown>;
         goal = {
            kind: g.kind === 'event' ? 'event' : 'page_reached',
            matchValue: String(g.match_value),
            matchPage: (g.match_page as string) || null,
            matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
         };
         goalMeta = { id: g.ID as number, name: String(g.name) };
      }

      // Human-only by default; the same composable segment filters as the other analytics routes.
      const includeBots = q.includeBots === 'true';
      const filters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const [eventRows, keywordRows] = await Promise.all([
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }),
         Keyword.findAll({ where: { domain, ...scopeWhere(account) }, attributes: ['keyword', 'position', 'target_page'] }),
      ]);

      const allSessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike));
      const botSessionsExcluded = filters.humanOnly ? allSessions.filter((s) => s.isBot).length : 0;
      const sessions = applyFilters(allSessions, filters);

      const keywords: EntryKeyword[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return { keyword: String(p.keyword), position: Number(p.position) || 0, targetPage: String(p.target_page || '') };
      });

      const report = buildEntryPageReport(sessions, keywords, goal);
      const note = report.totalEntries === 0
         ? 'No first-party sessions in this window/filter yet. Install the s33k.js tracking script so entry pages and sources flow in.'
         : `${report.totalEntries} first-touch session(s) across ${report.entryPages.filter((e) => e.entries > 0).length} entry page(s). `
            + 'Human-only by default. Pages with entries but no trackedKeywords land without ranking. '
            + 'Pages with trackedKeywords but zero entries rank without landing.';

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
      console.log('[ERROR] Building Entry Page Report for ', domain, error);
      return res.status(400).json({ error: 'Error Building Entry Page Report for this Domain.' });
   }
};
