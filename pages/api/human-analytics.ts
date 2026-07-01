import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import {
   sessionize, applyFilters, parseSegmentFilters, isEngaged, humanBotSplit,
   EventLike, SegmentFilters, SessionAgg,
} from '../../utils/sessionize';

// GET /api/human-analytics?domain=&period=[&includeBots=true][&<filters>]
//
// HUMAN-ONLY traffic analytics from s33k's OWN first-party sessions, with datacenter/bot traffic
// excluded by default (the is_bot flag set from the source IP at ingest, the signal a JS pageview
// tracker cannot see). Returns visitors, pageviews, pagesPerSession, bounceRatePct, entryPages,
// and exitPages WITH exitRatePct, plus botSharePct for transparency.
//
// Composable filters (all optional, shared with goal-analytics): channel (direct|referral|
// organic-search|ai; aliases seo/aio accepted), landingPage, page, device, country, engagement
// (engaged|bounced). includeBots=true folds bots back in.

type EntryPageRow = { page: string, entries: number, sharePct: number };
type ExitPageRow = { page: string, exits: number, pageviews: number, exitRatePct: number };

type HumanAnalyticsResponse = {
   domain?: string,
   period?: string,
   includesBots?: boolean,
   filters?: Record<string, unknown>,
   summary?: {
      visitors: number,
      pageviews: number,
      bounceRatePct: number,
      pagesPerSession: number,
      botVisitorsFiltered: number,
      botSharePct: number,
   },
   entryPages?: EntryPageRow[],
   exitPages?: ExitPageRow[],
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<HumanAnalyticsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getHumanAnalytics(req, res, account);
}

const getHumanAnalytics = async (req: NextApiRequest, res: NextApiResponse<HumanAnalyticsResponse>, account?: Account | null) => {
   const q = req.query;
   if (!q.domain || typeof q.domain !== 'string') { return res.status(400).json({ error: 'Domain is Required!' }); }
   const domain = q.domain as string;
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';
   const includeBots = q.includeBots === 'true';

   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const filters: SegmentFilters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const allSessions = sessionize(rows.map((r) => r.get({ plain: true }) as EventLike));

      // Bot transparency is computed BEFORE the segment filters, against the humanOnly cut. Uses the
      // shared first-party is_bot split so this number matches human_traffic, start_here, and the
      // dashboard headline exactly (one source of truth in utils/sessionize.ts).
      const split = humanBotSplit(allSessions);
      const botVisitors = split.bot;
      const { botSharePct } = split;

      // Apply the segment filters (humanOnly included). Traffic metrics are pageview-based.
      const sessions: SessionAgg[] = applyFilters(allSessions, filters).filter((s) => s.pageviewCount > 0);
      const visitors = sessions.length;
      const pageviews = sessions.reduce((sum, s) => sum + s.pageviewCount, 0);
      // Use the shared engaged/bounce test so this endpoint's bounce rate matches period-compare and
      // the engagement filter. `pageviewCount === 1` disagreed (it ignored non-pageview events).
      const bounced = sessions.filter((s) => !isEngaged(s)).length;
      const bounceRatePct = visitors > 0 ? Math.round((1000 * bounced) / visitors) / 10 : 0;
      const pagesPerSession = visitors > 0 ? Math.round((100 * pageviews) / visitors) / 100 : 0;

      const entryCounts = new Map<string, number>();
      const exitCounts = new Map<string, number>();
      const pageviewCounts = new Map<string, number>();
      for (const s of sessions) {
         entryCounts.set(s.landingPage, (entryCounts.get(s.landingPage) || 0) + 1);
         exitCounts.set(s.exitPage, (exitCounts.get(s.exitPage) || 0) + 1);
         for (const p of s.pageviewPaths) { pageviewCounts.set(p, (pageviewCounts.get(p) || 0) + 1); }
      }
      const entryPages: EntryPageRow[] = Array.from(entryCounts.entries())
         .map(([page, entries]) => ({ page, entries, sharePct: visitors > 0 ? Math.round((1000 * entries) / visitors) / 10 : 0 }))
         .sort((a, b) => b.entries - a.entries).slice(0, 25);
      const exitPages: ExitPageRow[] = Array.from(exitCounts.entries())
         .map(([page, exits]) => {
            const pv = pageviewCounts.get(page) || exits;
            return { page, exits, pageviews: pv, exitRatePct: pv > 0 ? Math.round((1000 * exits) / pv) / 10 : 0 };
         })
         .sort((a, b) => b.exits - a.exits).slice(0, 25);

      const note = pageviews === 0
         ? 'No first-party pageviews in this window/filter yet. Install the s33k.js tracking script on the site so human-only '
            + 'traffic, bounce, and exit rate can be computed from IP-classified pageviews.'
         : `Human-only by default (datacenter/bot excluded). ${botVisitors} bot visitor(s) seen (${botSharePct}% of all). `
            + 'Pass includeBots=true for raw numbers.';

      return res.status(200).json({
         domain,
         period,
         includesBots: includeBots,
         filters,
         summary: {
            visitors,
            pageviews,
            bounceRatePct,
            pagesPerSession,
            botVisitorsFiltered: includeBots ? 0 : botVisitors,
            botSharePct,
         },
         entryPages,
         exitPages,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Human Analytics for ', domain, error);
      return res.status(400).json({ error: 'Error Building Human Analytics for this Domain.' });
   }
};
