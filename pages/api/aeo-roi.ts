import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Goal from '../../database/models/goal';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike, GoalDef } from '../../utils/sessionize';
import { buildAeoRoi, AeoRoi, RoiKeyword } from '../../utils/aeo-roi';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * This route NEVER queries an LLM, NEVER embeds/fine-tunes, and NEVER transmits
 * account data to any external model. It reads first-party, un-gameable signals
 * s33k already records (AI-referred sessions, conversions, goal value) and JOINS
 * them in pure rules-based code (utils/aeo-roi.ts). Narration happens in the
 * USER's own LLM over MCP. Trust docs: SECURITY.md / security_facts.
 * ============================================================================
 */

/**
 * aeo_roi: "The AI Visibility P&L". The flagship cross-pillar differentiator.
 *
 * GET /api/aeo-roi?domain=example.com&period=30d&goal=Demo%20Booked  (or &goalId=1)
 *
 * Closes the loop no AEO tool can: AI-referred traffic -> conversions -> revenue,
 * PER PAGE, in one call. It does NOT call other API routes over HTTP: it reads the
 * SAME models (S33kEvent for sessions, Goal, Keyword) and reuses the SAME utils
 * (sessionize, buildAeoRoi) the AEO and conversion endpoints use, so the numbers
 * agree by construction.
 *
 * Resilience contract (mirrors conversion-attribution + aeo-report): db.sync,
 * authorize -> 401, GET guard -> 405, per-domain ownership gate -> 403, explicit
 * goal selector required -> 400, goal not found -> 404. The session read degrades to
 * an honest note on its own error rather than 500-ing the whole report. The join
 * itself stays honest: when a layer has no data the util says so instead of
 * fabricating a rate off a zero baseline.
 */

type Resp = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string, value: number | null },
   aeoRoi?: AeoRoi,
   // Non-fatal pillar errors, surfaced so a partial P&L is honest.
   sessionError?: string | null,
   note?: string | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getAeoRoi(req, res, account);
}

const getAeoRoi = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Verify the caller owns this domain BEFORE any pillar read. With MULTI_TENANT off scopeWhere is
   // {} so this matches by name; the domain column is globally @Unique so by-domain scoping cannot
   // leak across tenants.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // Resolve the goal the SAME way conversion-attribution / goal-analytics do: require an explicit
      // selector (else findOne would resolve on domain alone and silently pick an arbitrary goal),
      // validate a NaN goalId, 404 when the goal is not found.
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
      if (!hasGoalId && !hasGoalName) {
         return res.status(400).json({ error: 'Specify goalId or goal name.' });
      }
      const goalRow = await Goal.findOne({ where: goalWhere });
      if (!goalRow) { return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or list goals.' }); }
      const g = goalRow.get({ plain: true }) as Record<string, unknown>;
      const goal: GoalDef = {
         kind: g.kind === 'event' ? 'event' : 'page_reached',
         matchValue: String(g.match_value),
         matchPage: (g.match_page as string) || null,
         matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
      };
      const rawValue = g.value;
      const goalValue = typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;

      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();

      // Keywords (target-page context). Scoped. A thrown read here is non-fatal to the join; treat as
      // no keyword context rather than failing the whole P&L.
      let keywords: RoiKeyword[] = [];
      try {
         const keywordRows = await Keyword.findAll({ where: { domain, ...scopeWhere(account) }, attributes: ['keyword', 'target_page'] });
         keywords = keywordRows.map((k) => {
            const p = k.get({ plain: true }) as Record<string, unknown>;
            return { keyword: String(p.keyword), targetPage: String(p.target_page || '') };
         });
      } catch (kwErr) {
         console.log('[WARN] aeo-roi keyword read failed for ', domain, kwErr);
      }

      // --- HUMAN SESSIONS (AI-referred + organic baseline + conversions). Scoped. Human-only
      // (is_bot filtered in sessionize consumers via channel, but we keep bots out by reading all and
      // letting buildAeoRoi use only 'ai'/'organic-search' channels; bot rows never carry those
      // channels in practice). Degrades to [] + error.
      let sessionError: string | null = null;
      let sessions: ReturnType<typeof sessionize> = [];
      try {
         const eventRows = await S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            // 'id' is needed so sessionize's secondary-sort tiebreaker is deterministic on Postgres.
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         });
         sessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike)).filter((s) => !s.isBot);
      } catch (sessErr) {
         sessionError = sessErr instanceof Error ? sessErr.message : String(sessErr);
      }

      const aeoRoi = buildAeoRoi(sessions, goal, keywords, goalValue);

      return res.status(200).json({
         domain,
         period,
         goal: { id: g.ID as number, name: String(g.name), value: goalValue },
         aeoRoi,
         sessionError,
         note: aeoRoi.note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building AEO ROI for ', domain, error);
      return res.status(400).json({ error: 'Error Building AEO ROI for this Domain.' });
   }
};
