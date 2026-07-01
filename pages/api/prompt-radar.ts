import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import PromptCheck from '../../database/models/promptCheck';
import Goal from '../../database/models/goal';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike, GoalDef, SessionAgg, sessionConverted } from '../../utils/sessionize';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * This route NEVER queries an AI engine and NEVER calls an LLM. It reads prompt
 * RESULTS that the user's own LLM previously recorded (prompt-record), joins them
 * to first-party owned conversion + AI-referral data in pure rules-based code, and
 * returns the structured join for the user's own LLM to narrate.
 * ============================================================================
 */

// GET /api/prompt-radar?domain=&period=&goal= (or &goalId=)
//
// The prompt_radar JOIN, the money question only s33k can answer: "are AI engines citing me for my
// buyer prompts, AND do the pages they cite actually convert?" For each tracked prompt that has a
// RECORDED citation (engine + cited=true + cited_url), it joins the cited page to that page's
// conversion count/rate (when a goal is named) and its AI-referral sessions, all from owned data.
//
// Honest when empty: a prompt with no recorded result, or a domain with no recorded citations, is
// reported as such ("no prompt results recorded yet"), never invented.

type CitedPromptRow = {
   id: number,
   prompt: string,
   engine: string | null,
   cited: boolean | null,
   position: number | null,
   citedUrl: string | null,
   checkedAt: string | null,
   // Per-cited-page join (only meaningful when citedUrl is set):
   aiReferralSessions: number, // AI-channel sessions landing on the cited page in the window
   landingSessions: number, // all human sessions landing on the cited page in the window
   conversions: number | null, // goal conversions among sessions that viewed the cited page (null without a goal)
   conversionRatePct: number | null, // conversions / landingSessions (null without a goal)
};

type PromptRadarResponse = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   summary?: {
      trackedPrompts: number,
      promptsWithResults: number,
      citedPrompts: number,
      uncitedPrompts: number,
   },
   citedFor?: CitedPromptRow[],
   uncited?: { id: number, prompt: string, engine: string | null, checkedAt: string | null }[],
   moneyInsight?: string,
   note?: string | null,
   sessionError?: string | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<PromptRadarResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getRadar(req, res, account);
}

const rate = (c: number, s: number): number => (s > 0 ? Math.round((1000 * c) / s) / 10 : 0);

// Normalize a path/URL for comparison: drop origin, lowercase, strip a trailing slash.
const normPath = (p: string): string => {
   let s = String(p || '').trim().toLowerCase();
   s = s.replace(/^https?:\/\/[^/]+/, '');
   const q = s.indexOf('?');
   if (q !== -1) { s = s.slice(0, q); }
   if (s.length > 1) { s = s.replace(/\/+$/, ''); }
   return s || '/';
};

const getRadar = async (req: NextApiRequest, res: NextApiResponse<PromptRadarResponse>, account?: Account | null) => {
   const rawDomain = typeof req.query.domain === 'string' ? req.query.domain : '';
   if (!rawDomain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const domain = canonicalizeDomain(rawDomain);
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // Ownership gate before any read. With MULTI_TENANT off scopeWhere is {} so this matches by name.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

      // Optional goal selector. Like the other conversion routes, require an explicit selector when one
      // is given (else findOne would pick an arbitrary goal); a missing selector means "no goal".
      let goal: GoalDef | null = null;
      let goalMeta: { id: number, name: string } | null = null;
      const hasGoalId = typeof req.query.goalId === 'string' && req.query.goalId.trim();
      const hasGoalName = typeof req.query.goal === 'string' && req.query.goal.trim();
      if (hasGoalId || hasGoalName) {
         const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
         if (hasGoalId) {
            const gid = parseInt(req.query.goalId as string, 10);
            if (!Number.isFinite(gid)) { return res.status(400).json({ error: 'goalId must be a number.' }); }
            goalWhere.ID = gid;
         } else {
            goalWhere.name = (req.query.goal as string).trim();
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

      // Tracked prompts (owner-scoped). These carry the recorded citation results the user's LLM wrote.
      const promptRows = await PromptCheck.findAll({ where: { domain, ...scopeWhere(account) }, order: [['created', 'ASC']] });
      const prompts = promptRows.map((r) => r.get({ plain: true }) as Record<string, unknown>);

      const trackedPrompts = prompts.length;
      const withResults = prompts.filter((p) => p.checked_at);
      const cited = withResults.filter((p) => p.cited === true);
      const uncitedRows = withResults.filter((p) => p.cited !== true);

      // Sessions (owned, human-only) for the per-cited-page join. Degrades to [] + a sessionError note
      // rather than failing the whole radar (mirrors aeo-roi / conversion-attribution).
      let sessionError: string | null = null;
      let sessions: SessionAgg[] = [];
      try {
         const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
         const eventRows = await S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         });
         sessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike)).filter((s) => !s.isBot);
      } catch (sessErr) {
         sessionError = sessErr instanceof Error ? sessErr.message : String(sessErr);
      }

      // Per cited page: AI-referral landings, all human landings, and goal conversions among sessions
      // that VIEWED the page (view-attributed, consistent with the content-performance join).
      const joinPage = (citedUrl: string | null): {
         aiReferralSessions: number, landingSessions: number, conversions: number | null, conversionRatePct: number | null,
      } => {
         if (!citedUrl) { return { aiReferralSessions: 0, landingSessions: 0, conversions: null, conversionRatePct: null }; }
         const target = normPath(citedUrl);
         const landed = sessions.filter((s) => normPath(s.landingPage) === target);
         const aiLanded = landed.filter((s) => s.channel === 'ai');
         if (!goal) {
            return { aiReferralSessions: aiLanded.length, landingSessions: landed.length, conversions: null, conversionRatePct: null };
         }
         const viewed = sessions.filter((s) => s.pageviewPaths.some((p) => normPath(p) === target));
         const conversions = viewed.filter((s) => sessionConverted(s, goal as GoalDef)).length;
         return {
            aiReferralSessions: aiLanded.length,
            landingSessions: landed.length,
            conversions,
            conversionRatePct: rate(conversions, landed.length),
         };
      };

      const citedFor: CitedPromptRow[] = cited.map((p) => {
         const join = joinPage((p.cited_url as string) || null);
         return {
            id: p.ID as number,
            prompt: String(p.prompt),
            engine: (p.engine as string) || null,
            cited: p.cited as boolean,
            position: (p.position as number) ?? null,
            citedUrl: (p.cited_url as string) || null,
            checkedAt: (p.checked_at as string) || null,
            ...join,
         };
      }).sort((a, b) => (b.conversions ?? 0) - (a.conversions ?? 0) || b.aiReferralSessions - a.aiReferralSessions);

      const uncited = uncitedRows.map((p) => ({
         id: p.ID as number,
         prompt: String(p.prompt),
         engine: (p.engine as string) || null,
         checkedAt: (p.checked_at as string) || null,
      }));

      // The money insight: surface the gap between citation and conversion. Honest at every empty step.
      const moneyInsight = buildMoneyInsight({
         trackedPrompts,
         promptsWithResults: withResults.length,
         citedCount: cited.length,
         citedFor,
         hasGoal: Boolean(goal),
      });

      const note = withResults.length === 0
         ? 'No prompt results recorded yet. Track prompts with prompt_track, then have your assistant run them against the AI '
            + 'engines and record what it found with prompt_record. s33k never queries an engine itself.'
         : null;

      return res.status(200).json({
         domain,
         period,
         goal: goalMeta,
         summary: {
            trackedPrompts,
            promptsWithResults: withResults.length,
            citedPrompts: cited.length,
            uncitedPrompts: uncitedRows.length,
         },
         citedFor,
         uncited,
         moneyInsight,
         note,
         sessionError,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Prompt Radar for ', domain, error);
      return res.status(400).json({ error: 'Error Building Prompt Radar for this Domain.' });
   }
};

// Compose the plain-English money insight from the join. Deterministic strings for the user's LLM to
// narrate; honest on every empty branch rather than fabricating a number.
const buildMoneyInsight = (a: {
   trackedPrompts: number, promptsWithResults: number, citedCount: number, citedFor: CitedPromptRow[], hasGoal: boolean,
}): string => {
   if (a.trackedPrompts === 0) {
      return 'No buyer prompts tracked yet. Track the prompts your buyers ask with prompt_track to start the radar.';
   }
   if (a.promptsWithResults === 0) {
      return 'No prompt results recorded yet. Have your assistant run each tracked prompt against the AI engines and record the '
         + 'result with prompt_record (s33k does not query engines itself), then ask again.';
   }
   if (a.citedCount === 0) {
      return `You are cited in 0 of ${a.promptsWithResults} prompt(s) with results. The AI engines are not surfacing this site for `
         + 'those buyer prompts yet: make the target pages more citation-ready (clear claims up top, structured answers).';
   }
   const base = `You are cited in ${a.citedCount} of ${a.promptsWithResults} prompt(s) with results.`;
   if (!a.hasGoal) {
      return `${base} Pass a goal to join each cited page to its conversion rate and see whether the pages AI cites actually convert.`;
   }
   // With a goal: find the best-converting cited page and whether any cited page converts at all.
   const converting = a.citedFor.filter((r) => (r.conversions ?? 0) > 0);
   if (converting.length === 0) {
      return `${base} But none of the cited pages converted in this window: AI is citing pages that do not convert. Fix the cited `
         + 'pages (clearer offer, stronger CTA) so the AI visibility you have turns into outcomes.';
   }
   const best = converting[0];
   return `${base} Your best-converting cited page is ${best.citedUrl} with ${best.conversions} conversion(s) `
      + `(${best.conversionRatePct}% of its landing sessions). Double down on the buyer prompts that cite the pages that convert.`;
};
