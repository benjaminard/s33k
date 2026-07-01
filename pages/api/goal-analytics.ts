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
import {
   sessionize, applyFilters, sessionConverted, parseSegmentFilters,
   EventLike, SegmentFilters, GoalDef, SessionAgg,
} from '../../utils/sessionize';

// GET /api/goal-analytics?domain=&period=&goalId=|goal=&groupBy=&<filters>
//
// Conversion analytics for a NAMED goal, computed from first-party sessions. Answers the questions
// a marketer actually asks:
//   - "conversion rate for <goal>, human only"            -> humanOnly default + conversionRatePct
//   - "how many AI referrals converted to <goal>"         -> channel=ai + conversions
//   - "compare conversion rate by source"                 -> groupBy=channel
//   - "of converters, what was the most common landing page" -> groupBy=landingPage (sort groups)
//
// Filters (all composable, all optional): channel (direct|referral|organic-search|ai, aliases seo/aio
// accepted), landingPage, page, device, country, engagement (engaged|bounced), and humanOnly
// (default TRUE, set includeBots=true to fold bots back in). groupBy: channel | landingPage |
// exitPage | device | country (default none).

// revenue is OPTIONAL per group: present only when the goal carries a value, and equal to that
// group's conversions * goal value. A value-less goal omits revenue and the shape is unchanged.
type Group = { key: string, sessions: number, conversions: number, conversionRatePct: number, revenue?: number };
type GoalAnalyticsResponse = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string, kind: string, match: string, value: number | null },
   filters?: Record<string, unknown>,
   totalSessions?: number,
   conversions?: number,
   conversionRatePct?: number,
   // When the goal carries a monetary value: goalValue echoes it and totalRevenue is
   // conversions * goalValue. When the goal has no value, goalValue and totalRevenue are always
   // present and null (never omitted), and only the per-group revenue field is omitted.
   goalValue?: number | null,
   totalRevenue?: number | null,
   botSessionsExcluded?: number,
   groupBy?: string,
   groups?: Group[],
   note?: string,
   error?: string | null,
};

const GROUP_KEYS: Record<string, (s: SessionAgg) => string> = {
   channel: (s) => s.channel,
   landingPage: (s) => s.landingPage,
   exitPage: (s) => s.exitPage,
   device: (s) => s.device || 'unknown',
   country: (s) => s.country || 'unknown',
};

const rate = (conversions: number, sessions: number): number => (sessions > 0 ? Math.round((1000 * conversions) / sessions) / 10 : 0);
// Round money to cents so conversions * a fractional value never reports a long float tail.
const money = (n: number): number => Math.round(n * 100) / 100;

export default async function handler(req: NextApiRequest, res: NextApiResponse<GoalAnalyticsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getGoalAnalytics(req, res, account);
}

const getGoalAnalytics = async (req: NextApiRequest, res: NextApiResponse<GoalAnalyticsResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // Resolve the goal by id or name (scoped).
      const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
      const hasGoalId = typeof q.goalId === 'string' && q.goalId.trim();
      const hasGoalName = typeof q.goal === 'string' && q.goal.trim();
      if (hasGoalId) {
         const gid = parseInt(q.goalId as string, 10);
         if (!Number.isFinite(gid)) { return res.status(400).json({ error: 'goalId must be a number.' }); }
         goalWhere.ID = gid;
      } else if (hasGoalName) {
         goalWhere.name = (q.goal as string).trim();
      }
      // Without a goalId/goal predicate, findOne would resolve on domain alone and silently pick an
      // arbitrary goal, reporting its rate as if requested. Require an explicit goal selector.
      if (!hasGoalId && !hasGoalName) {
         return res.status(400).json({ error: 'Specify goalId or goal name.' });
      }
      const goalRow = await Goal.findOne({ where: goalWhere });
      if (!goalRow) {
         return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or list goals.' });
      }
      const g = goalRow.get({ plain: true }) as Record<string, unknown>;
      const goal: GoalDef = {
         kind: g.kind === 'event' ? 'event' : 'page_reached',
         matchValue: String(g.match_value),
         matchPage: (g.match_page as string) || null,
         matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
      };
      // When the goal carries a value, ALSO report revenue (conversions * value). A value-less goal
      // (null) keeps the prior shape: no goalValue/totalRevenue and no per-group revenue.
      const rawValue = g.value;
      const goalValue = typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;
      const hasValue = goalValue !== null;

      // Build filters from the query (composable; unset = no-op). humanOnly defaults TRUE.
      const includeBots = q.includeBots === 'true';
      const filters: SegmentFilters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      // Load all events in the window (both human and bot, so bot exclusion is reported).
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         // 'id' is needed so sessionize's secondary-sort tiebreaker (by id) is deterministic.
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const allSessions = sessionize(rows.map((r) => r.get({ plain: true }) as EventLike));
      const botSessionsExcluded = filters.humanOnly ? allSessions.filter((s) => s.isBot).length : 0;

      const sessions = applyFilters(allSessions, filters);
      const totalSessions = sessions.length;
      const converters = sessions.filter((s) => sessionConverted(s, goal));
      const conversions = converters.length;

      // Optional groupBy breakdown.
      const groupBy = typeof q.groupBy === 'string' && GROUP_KEYS[q.groupBy] ? q.groupBy : 'none';
      let groups: Group[] = [];
      if (groupBy !== 'none') {
         const keyFn = GROUP_KEYS[groupBy];
         const bucket = new Map<string, { sessions: number, conversions: number }>();
         for (const s of sessions) {
            const k = keyFn(s) || 'unknown';
            if (!bucket.has(k)) { bucket.set(k, { sessions: 0, conversions: 0 }); }
            const b = bucket.get(k) as { sessions: number, conversions: number };
            b.sessions += 1;
            if (sessionConverted(s, goal)) { b.conversions += 1; }
         }
         groups = Array.from(bucket.entries())
            .map(([key, v]) => {
               const grp: Group = { key, sessions: v.sessions, conversions: v.conversions, conversionRatePct: rate(v.conversions, v.sessions) };
               if (hasValue) { grp.revenue = money(v.conversions * (goalValue as number)); }
               return grp;
            })
            .sort((a, b) => b.conversions - a.conversions || b.sessions - a.sessions)
            .slice(0, 50);
      }

      // The filter note must match what actually ran: only claim "Human-only" when bots were filtered.
      const filterNote = filters.humanOnly
         ? `Human-only by default${botSessionsExcluded ? ` (${botSessionsExcluded} bot session(s) excluded)` : ''}`
         : 'Bots included';
      const totalRevenue = hasValue ? money(conversions * (goalValue as number)) : null;
      const revenueNote = totalRevenue !== null ? ` Worth ~${totalRevenue} at ${goalValue} per conversion.` : '';
      const note = totalSessions === 0
         ? 'No first-party sessions in this window/filter yet. Install the s33k.js tracking script so pageviews and events flow in.'
         : `${conversions} of ${totalSessions} session(s) completed "${g.name}". ${filterNote}.${revenueNote}`;

      const matchDesc = goal.kind === 'event'
         ? `${goal.matchValue}${goal.matchPage ? ` on ${goal.matchPage}` : ''}`
         : `${goal.matchMode} ${goal.matchValue}`;

      return res.status(200).json({
         domain,
         period,
         goal: { id: g.ID as number, name: String(g.name), kind: goal.kind, match: matchDesc, value: goalValue },
         filters,
         totalSessions,
         conversions,
         conversionRatePct: rate(conversions, totalSessions),
         goalValue,
         totalRevenue,
         botSessionsExcluded,
         groupBy,
         groups,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Goal Analytics for ', domain, error);
      return res.status(400).json({ error: 'Error Building Goal Analytics for this Domain.' });
   }
};
