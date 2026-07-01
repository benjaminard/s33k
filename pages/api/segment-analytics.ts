import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Segment from '../../database/models/segment';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { parseStoredSegmentFilters } from '../../utils/segmentFilters';
import {
   sessionize, applyFilters, isEngaged, EventLike, SegmentFilters, SessionAgg,
} from '../../utils/sessionize';

// GET /api/segment-analytics?domain=&segment=NAME|segmentId=&period=
//
// Human-analytics-style traffic summary for a SAVED SEGMENT, applied by name. Loads the named
// segment, parses its stored SegmentFilters spec, and runs it through the same sessionize engine as
// /api/human-analytics, so the numbers are identical to specifying those filters inline. This is the
// "name a reusable filter set once, apply it forever" payoff: a user asks for "AI human converters"
// by name instead of re-typing channel=ai&humanOnly=true on every call.
//
// humanOnly is whatever the segment stored (defaulting to true when the segment did not set it, the
// same human-first default as the analytics routes). The segment's own filters are the only filters;
// no inline override, on purpose, so the saved cut is reproducible.

type EntryPageRow = { page: string, entries: number, sharePct: number };
type ExitPageRow = { page: string, exits: number, pageviews: number, exitRatePct: number };

type SegmentAnalyticsResponse = {
   domain?: string,
   period?: string,
   segment?: { id: number, name: string },
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

export default async function handler(req: NextApiRequest, res: NextApiResponse<SegmentAnalyticsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getSegmentAnalytics(req, res, account);
}

const getSegmentAnalytics = async (req: NextApiRequest, res: NextApiResponse<SegmentAnalyticsResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // Resolve the segment by id or name (scoped). Like goal-analytics, require an explicit selector
      // so findOne never silently resolves to an arbitrary segment on the domain.
      const segWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
      const hasSegmentId = typeof q.segmentId === 'string' && q.segmentId.trim();
      const hasSegmentName = typeof q.segment === 'string' && q.segment.trim();
      if (hasSegmentId) {
         const sid = parseInt(q.segmentId as string, 10);
         if (!Number.isFinite(sid)) { return res.status(400).json({ error: 'segmentId must be a number.' }); }
         segWhere.ID = sid;
      } else if (hasSegmentName) {
         segWhere.name = (q.segment as string).trim();
      } else {
         return res.status(400).json({ error: 'Specify segmentId or segment name.' });
      }
      const segRow = await Segment.findOne({ where: segWhere });
      if (!segRow) {
         return res.status(404).json({ error: 'Segment not found. Create it first with segment_save, or list segments.' });
      }
      const seg = segRow.get({ plain: true }) as Record<string, unknown>;

      // The saved spec IS the filter set. Default humanOnly to true when the segment did not pin it,
      // matching the human-first default of /api/human-analytics.
      const stored = parseStoredSegmentFilters(seg.filters as string);
      const filters: SegmentFilters = { ...stored, humanOnly: stored.humanOnly !== false };

      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const allSessions = sessionize(rows.map((r) => r.get({ plain: true }) as EventLike));

      // Bot transparency is computed BEFORE the segment filters (same as human-analytics).
      const botVisitors = allSessions.filter((s) => s.isBot).length;
      const totalForShare = allSessions.length;
      const botSharePct = totalForShare > 0 ? Math.round((1000 * botVisitors) / totalForShare) / 10 : 0;

      // Apply the saved segment filters. Traffic metrics are pageview-based.
      const sessions: SessionAgg[] = applyFilters(allSessions, filters).filter((s) => s.pageviewCount > 0);
      const visitors = sessions.length;
      const pageviews = sessions.reduce((sum, s) => sum + s.pageviewCount, 0);
      // Shared engaged/bounce test so this matches human-analytics and period-compare exactly.
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
         ? `No first-party pageviews match segment "${String(seg.name)}" in this window yet. Install the s33k.js tracking script, `
            + 'or widen the segment filters.'
         : `Segment "${String(seg.name)}" applied. ${filters.humanOnly ? 'Human-only (datacenter/bot excluded). ' : 'Bots included. '}`
            + `${botVisitors} bot visitor(s) seen overall (${botSharePct}% of all).`;

      return res.status(200).json({
         domain,
         period,
         segment: { id: seg.ID as number, name: String(seg.name) },
         filters,
         summary: {
            visitors,
            pageviews,
            bounceRatePct,
            pagesPerSession,
            botVisitorsFiltered: filters.humanOnly ? botVisitors : 0,
            botSharePct,
         },
         entryPages,
         exitPages,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Segment Analytics for ', domain, error);
      return res.status(400).json({ error: 'Error Building Segment Analytics for this Domain.' });
   }
};
