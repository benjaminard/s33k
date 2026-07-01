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
import { sessionize, applyFilters, EventLike, GoalDef } from '../../utils/sessionize';
import { buildPeriodCompare, PeriodCompareReport } from '../../utils/period-compare';

// GET /api/period-compare?domain=&period=&goal=|goalId=&includeBots=
//
// Side-by-side comparison of the key analytics metrics for a window vs the immediately-preceding
// equal-length window: humanVisitors, pageviews, bounceRatePct, and (with a goal) conversions +
// conversionRatePct, each with its delta and pctChange. This answers "is this period better or worse
// than last period, and by how much", the single most-asked analytics question.
//
// The prior window is derived from periodStartMs: the current window is [start, now], so its length
// is (now - start), and the prior window is the equal-length window ending exactly at start, i.e.
// [start - len, start]. We pull both windows in ONE query (priorStart..now) and split in memory, so
// the math is a single pass and the two windows are guaranteed sessionized identically.
//
// Human-only by default; set includeBots=true to fold datacenter/bot sessions back in. No
// server-side LLM: structured rows out, the user's own LLM narrates.

type Resp = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   report?: PeriodCompareReport,
   botSessionsExcluded?: number,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getPeriodCompare(req, res, account);
}

const getPeriodCompare = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Ownership gate first: the domain column is globally unique, so by-domain scoping cannot leak
   // across tenants. 403 before any pillar read.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // Goal is OPTIONAL: omit it for the traffic-only comparison, pass it (by name or id) to add the
      // conversion metrics. A bad goal name 404s rather than silently dropping the conversion view.
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

      // Derive the two equal-length windows from one anchor. nowMs is captured once so both windows
      // share an identical clock and the prior window abuts the current one exactly (no gap/overlap).
      const nowMs = Date.now();
      const curStartMs = periodStartMs(period, nowMs);
      const windowLenMs = nowMs - curStartMs; // length of the current window
      const priorStartMs = curStartMs - windowLenMs;
      const curBounds = { startMs: curStartMs, endMs: nowMs };
      const priorBounds = { startMs: priorStartMs, endMs: curStartMs };

      // Human-only by default. We do NOT expose the deeper segment filters here on purpose: a
      // period-vs-period comparison is only honest if BOTH windows use the identical population, and
      // human-only/includeBots is the one toggle that keeps both windows symmetric.
      const includeBots = q.includeBots === 'true';
      const humanOnly = !includeBots;

      // Pull both windows in a single query (priorStart..now), then split each event into its window
      // by created time before sessionizing. Sessionizing each window independently is correct: a
      // session that straddles the boundary is rare and is attributed by where its events fall.
      const priorStartISO = new Date(priorStartMs).toJSON();
      const curStartISO = new Date(curStartMs).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: priorStartISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const plainRows = rows.map((r) => r.get({ plain: true }) as EventLike);

      // Split by the current-window start. created is an ISO string, so a lexical compare against the
      // ISO boundary is a correct chronological compare (ISO-8601 sorts lexically).
      const curRows = plainRows.filter((r) => r.created >= curStartISO);
      const priorRows = plainRows.filter((r) => r.created < curStartISO);

      const curAll = sessionize(curRows);
      const priorAll = sessionize(priorRows);
      // Bots excluded for reporting is the count across BOTH windows, so the caller sees the full
      // exclusion behind the comparison.
      const botSessionsExcluded = humanOnly
         ? curAll.filter((s) => s.isBot).length + priorAll.filter((s) => s.isBot).length
         : 0;

      const curSessions = applyFilters(curAll, { humanOnly });
      const priorSessions = applyFilters(priorAll, { humanOnly });

      const report = buildPeriodCompare(curSessions, curBounds, priorSessions, priorBounds, goal);

      const visitorsDelta = report.deltas.find((d) => d.metric === 'humanVisitors');
      const pct = visitorsDelta && visitorsDelta.pctChange !== null
         ? ` (${visitorsDelta.pctChange >= 0 ? '+' : ''}${visitorsDelta.pctChange}%)` : '';
      const note = (report.current.metrics.humanVisitors === 0 && report.prior.metrics.humanVisitors === 0)
         ? 'No first-party sessions in either window yet. Install the s33k.js tracking script so traffic flows in.'
         : `Comparing this ${period} window vs the prior equal-length window. `
            + `humanVisitors ${report.current.metrics.humanVisitors} vs ${report.prior.metrics.humanVisitors}${pct}. `
            + `Human-only by default${botSessionsExcluded ? ` (${botSessionsExcluded} bot session(s) excluded)` : ''}`
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
      console.log('[ERROR] Building Period Compare for ', domain, error);
      return res.status(400).json({ error: 'Error Building Period Compare for this Domain.' });
   }
};
