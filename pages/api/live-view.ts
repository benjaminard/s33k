import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { normalizeChannel, EventLike } from '../../utils/sessionize';

// GET /api/live-view?domain=&windowMinutes=5
//
// A polled real-time snapshot: who is on the site RIGHT NOW. This is meant to be called repeatedly
// by the user's LLM (no websocket, no streaming): each call is a fresh, cheap, time-bounded read of
// the last `windowMinutes` of first-party events. Human-only by default, because a "live visitors"
// number that counts datacenter scrapers is noise; the bot rows are tallied and reported separately
// so the figure stays honest rather than silently dropping traffic.
//
// Returns: activeVisitors (distinct human sessions in the window), pageviewsInWindow, activePages
// (pages currently being viewed, from type=pageview rows, with counts), sources and countries
// breakdowns, and recentEvents (the most recent N events, newest first) so the LLM can narrate
// what just happened.

type CountRow = { key: string, count: number };
type RecentEvent = { type: string, page: string, source: string, channel: string, country: string, device: string, created: string };

type LiveViewResponse = {
   domain?: string,
   windowMinutes?: number,
   asOf?: string,
   activeVisitors?: number,
   pageviewsInWindow?: number,
   eventsInWindow?: number,
   botEventsExcluded?: number,
   activePages?: CountRow[],
   sources?: CountRow[],
   countries?: CountRow[],
   recentEvents?: RecentEvent[],
   note?: string,
   error?: string | null,
};

// How many recent events to surface. Bounded so a busy window cannot return an unbounded payload to
// a tool that is meant to be polled often.
const RECENT_LIMIT = 20;
// Clamp the window so a caller cannot turn a "live" snapshot into a full-history scan.
const MAX_WINDOW_MINUTES = 60;

// Tally a list of string keys into a descending-by-count breakdown. Empty/absent keys roll up under
// a single 'unknown' bucket so the breakdown stays readable.
const tally = (keys: string[]): CountRow[] => {
   const bucket = new Map<string, number>();
   for (const raw of keys) {
      const k = raw && raw.trim() ? raw.trim() : 'unknown';
      bucket.set(k, (bucket.get(k) || 0) + 1);
   }
   return Array.from(bucket.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<LiveViewResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getLiveView(req, res, account);
}

const getLiveView = async (req: NextApiRequest, res: NextApiResponse<LiveViewResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   // windowMinutes defaults to 5, clamped to [1, MAX_WINDOW_MINUTES]. NaN/garbage falls back to 5.
   const requested = parseInt(typeof q.windowMinutes === 'string' ? q.windowMinutes : '', 10);
   const windowMinutes = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_WINDOW_MINUTES) : 5;

   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const nowMs = Date.now();
      const startISO = new Date(nowMs - windowMinutes * 60e3).toJSON();
      // Pull the window once (human + bot) so bot exclusion can be reported rather than hidden.
      const rows = (await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'DESC']],
      })).map((r) => r.get({ plain: true }) as EventLike);

      const botEventsExcluded = rows.filter((r) => r.is_bot).length;
      // Default human-only: a live-visitors count that includes datacenter scrapers is misleading.
      const human = rows.filter((r) => !r.is_bot);

      const activeVisitors = new Set(human.map((r) => r.session).filter(Boolean)).size;
      const pageviews = human.filter((r) => r.type === 'pageview');
      const pageviewsInWindow = pageviews.length;

      // Pages "currently being viewed" come from pageview rows only (an event row's page is where an
      // interaction happened, not necessarily a view).
      const activePages = tally(pageviews.map((r) => r.page));
      // Source breakdown is normalized to the channel vocabulary (direct/referral/organic-search/ai)
      // so it lines up with every other s33k traffic surface.
      const sources = tally(human.map((r) => normalizeChannel(r.source)));
      const countries = tally(human.map((r) => String(r.country || '').toUpperCase()));

      // recentEvents is newest-first (rows already ordered DESC), human-only, capped.
      const recentEvents: RecentEvent[] = human.slice(0, RECENT_LIMIT).map((r) => ({
         type: r.type,
         page: r.page,
         source: String(r.source || ''),
         channel: normalizeChannel(r.source),
         country: String(r.country || '').toUpperCase(),
         device: String(r.device || ''),
         created: r.created,
      }));

      const note = human.length === 0
         ? `No human activity in the last ${windowMinutes} minute(s). Poll again, or install the s33k.js tracking script if no traffic ever appears.`
         : `${activeVisitors} active visitor(s) across ${pageviewsInWindow} pageview(s) in the last ${windowMinutes} minute(s). Human-only`
            + `${botEventsExcluded ? ` (${botEventsExcluded} bot event(s) excluded)` : ''}. Poll repeatedly for a live view.`;

      return res.status(200).json({
         domain,
         windowMinutes,
         asOf: new Date(nowMs).toJSON(),
         activeVisitors,
         pageviewsInWindow,
         eventsInWindow: human.length,
         botEventsExcluded,
         activePages,
         sources,
         countries,
         recentEvents,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Live View for ', domain, error);
      return res.status(400).json({ error: 'Error Building Live View for this Domain.' });
   }
};
