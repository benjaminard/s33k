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
import { sessionize, applyFilters, parseSegmentFilters, EventLike } from '../../utils/sessionize';
import { analyzeFunnel, parseFunnelSteps, FunnelAnalysis } from '../../utils/funnel-analysis';

// GET /api/funnel?domain=&period=&steps=<JSON array>[&filters]
//
// Multi-step funnel with per-step drop-off, computed from first-party sessions. `steps` is an
// ORDERED JSON array (a funnel is an ordered list, which flat query params cannot express, so it
// arrives as a JSON string and is parsed here) of {type:"page"|"event", match:string, page?}. For
// each session we walk the steps in order and stop at the first one missed, so a session counts for
// step N only if it also reached steps 1..N-1. Per step: reached count, conversionFromPrevious %,
// and drop-off %. Human-only by default (set includeBots=true to fold bots in); the same composable
// segment filters as the other analytics routes apply. Deterministic, no LLM.

type FunnelResponse = {
   domain?: string,
   period?: string,
   filters?: Record<string, unknown>,
   funnel?: FunnelAnalysis,
   botSessionsExcluded?: number,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<FunnelResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getFunnel(req, res, account);
}

const getFunnel = async (req: NextApiRequest, res: NextApiResponse<FunnelResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Validate the funnel shape BEFORE touching the DB: a bad/missing steps array is a 400 with a
   // clear message, not a generic failure after a wasted query.
   const { steps, error: stepsError } = parseFunnelSteps(q.steps);
   if (stepsError || !steps) { return res.status(400).json({ error: stepsError }); }

   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // Human-only by default. Load both human and bot rows so the excluded-bot count is reportable.
      const includeBots = q.includeBots === 'true';
      const filters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });

      const allSessions = sessionize(rows.map((r) => r.get({ plain: true }) as EventLike));
      const botSessionsExcluded = filters.humanOnly ? allSessions.filter((s) => s.isBot).length : 0;
      const sessions = applyFilters(allSessions, filters);

      const funnel = analyzeFunnel(sessions, steps);
      const last = funnel.steps[funnel.steps.length - 1];

      const note = funnel.totalSessions === 0
         ? 'No first-party sessions in this window/filter yet. Install the s33k.js tracking script so pageviews and events flow in.'
         : `${last.reached} of ${funnel.totalSessions} session(s) completed all ${funnel.steps.length} step(s). `
            + `Human-only by default${botSessionsExcluded ? ` (${botSessionsExcluded} bot session(s) excluded)` : ''}.`;

      return res.status(200).json({
         domain,
         period,
         filters,
         funnel,
         botSessionsExcluded,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Funnel Analysis for ', domain, error);
      return res.status(400).json({ error: 'Error Building Funnel Analysis for this Domain.' });
   }
};
