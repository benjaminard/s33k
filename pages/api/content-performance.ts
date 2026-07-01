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
import { buildContentPerformance, PerfKeyword, ContentPerfReport } from '../../utils/content-performance';

// GET /api/content-performance?domain=&period=&goal=|goalId=&includeBots=&limit=[&filters]
//
// The "which content actually performs" report: rank a domain's pages by pageviews, then join the
// signals that say whether a top page is doing real work. Per page it returns pageviews (the rank),
// entries (sessions that LANDED there, the acquisition signal), optional goal conversions+rate
// (view-attributed over sessions that saw the page), and the tracked keywords whose target page is
// that page (so each top page shows what it ranks for). This is the cross-pillar content scorecard:
// traffic + acquisition + conversion + SEO, per page, in one view.
//
// Human-only by default (datacenter bots excluded); set includeBots=true to fold them in. The goal
// is OPTIONAL: omit it for the pure traffic view, pass it to add conversion columns per page.

type Resp = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   report?: ContentPerfReport,
   botSessionsExcluded?: number,
   note?: string,
   error?: string | null,
};

// Clamp the top-N page limit to a sane range. Default 25 keeps the report a readable "top pages"
// scorecard; the cap of 200 bounds the payload an LLM has to read.
const parseLimit = (raw: unknown): number => {
   const n = parseInt(String(raw), 10);
   if (!Number.isFinite(n)) { return 25; }
   return Math.min(200, Math.max(1, n));
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getContentPerformance(req, res, account);
}

const getContentPerformance = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
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
            goalWhere.ID = parseInt(q.goalId, 10);
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
      const limit = parseLimit(q.limit);

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

      const keywords: PerfKeyword[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return { keyword: String(p.keyword), position: Number(p.position) || 0, targetPage: String(p.target_page || '') };
      });

      const report = buildContentPerformance(sessions, keywords, goal, limit);
      const note = report.totalPageviews === 0
         ? 'No first-party pageviews in this window/filter yet. Install the s33k.js tracking script so page traffic flows in.'
         : `Top ${report.pages.length} page(s) by pageviews over ${period}. Human-only by default. `
            + 'entries = sessions that landed on the page. keywords = what the page ranks for'
            + `${goalMeta ? `. conversions/rate are view-attributed for "${goalMeta.name}"` : ''}.`;

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
      console.log('[ERROR] Building Content Performance for ', domain, error);
      return res.status(400).json({ error: 'Error Building Content Performance for this Domain.' });
   }
};
