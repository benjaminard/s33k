import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, ReferralSource } from '../../utils/analytics';
import { cleanPath } from '../../utils/clean-path';
import { auditCitability, CitabilityAudit } from '../../utils/citability-audit';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * s33k NEVER sends customer data to a model trainer and has NO model-training
 * pipeline anywhere in the codebase. This route measures AI visibility from
 * first-party, un-gameable behavior s33k already records (AI referral traffic)
 * plus a deterministic on-page citability audit. It NEVER queries an LLM and
 * never transmits account data to any external model. Any interpretation happens
 * in the USER's own LLM over MCP. Full trust documentation: SECURITY.md (and the
 * security_facts MCP tool).
 * ============================================================================
 */

/**
 * AI Visibility.
 *
 * GET /api/ai-visibility?domain=example.com&period=30d
 *
 * Measures a domain's standing in AI search using only first-party, un-gameable
 * behavior s33k already records: which AI engines REFER traffic (the outcome,
 * from analytics referrals). It NEVER queries an LLM and never asks an AI engine
 * whether it cites the site.
 *
 *   - per page (pages[]): is the page cited by an AI engine (an AI referral
 *     landed there) or not, expressed as a status (see PageStatus).
 *   - per engine (engines[]): does the engine refer traffic (advocate) or not
 *     (absent).
 *   - a summary: total AI referrals and the top advocate engine.
 *
 * When that first-party data is thin (no AI referrals), the response ALSO carries
 * an optional AI-citability audit: it fetches the domain's top pages and scores
 * their AI-readiness (llms.txt, Markdown twins, JSON-LD, answer-shaped content).
 * The audit is deterministic and never queries an LLM.
 *
 * Follows the wired analytics-route pattern: authorize() then verify the caller
 * owns the domain (403 otherwise). Degrades gracefully and never 500s on a
 * sub-signal failure.
 */

/**
 * A page's standing in AI search.
 *   ai-cited   an AI engine referred a visitor to the page: it is cited.
 *   not-cited  no AI referral recorded for the page yet.
 */
type PageStatus = 'ai-cited' | 'not-cited';

/**
 * An engine's standing.
 *   advocate   refers traffic: working for you.
 *   absent     no referrals in the window.
 */
type EngineStatus = 'advocate' | 'absent';

type PageReferralRef = {
   engine: string,
   visitors: number,
};

type AiVisibilityPage = {
   path: string,
   isCited: boolean,
   status: PageStatus,
   aiReferralVisitors: number,
   referredBy: PageReferralRef[],
};

type AiVisibilityEngine = {
   engine: string,
   owner: string | null,
   status: EngineStatus,
   referrals: number,
   referredPages: string[],
};

type VisibilitySummary = {
   totalAIReferrals: number,
   /** The engine doing the most for you (advocate with the most referrals), or null. */
   topAdvocate: string | null,
};

type AiVisibilityResponse = {
   domain?: string,
   period?: string,
   engines?: AiVisibilityEngine[],
   pages?: AiVisibilityPage[],
   summary?: VisibilitySummary,
   dataIsThin?: boolean,
   citabilityAudit?: CitabilityAudit | null,
   referralError?: string | null,
   referralLandingAvailable?: boolean,
   note?: string | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<AiVisibilityResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAiVisibility(req, res, account);
}

const getAiVisibility = async (req: NextApiRequest, res: NextApiResponse<AiVisibilityResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // Verify the caller may access this domain before exposing any of its data, via the
   // per-domain chokepoint. MULTI_TENANT off -> matches by domain name; on -> owned (M2: shared).
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      // AI REFERRALS: read referral sources from the analytics provider and keep
      // AI engines only. Same classification path as /api/ai-referrals. Most
      // providers report referrals site-wide (no landing_path), in which case
      // per-page citation cannot be attributed and is surfaced honestly.
      let referralError: string | null = null;
      let aiReferralSources: ReferralSource[] = [];
      try {
         const { sources, error: refError } = await getAnalyticsProvider().getReferralSources(domain, period);
         referralError = refError;
         aiReferralSources = (sources || []).filter((s) => s.isAI);
      } catch (refErr) {
         referralError = refErr instanceof Error ? refErr.message : String(refErr);
         aiReferralSources = [];
      }
      const referralLandingAvailable = aiReferralSources.some((s) => Boolean(s.landing_path));

      // Build the per-page view. Cited pages come from referrals only when a
      // landing_path is available.
      const pageMap = new Map<string, AiVisibilityPage>();
      const ensurePage = (rawPath: string): AiVisibilityPage => {
         const path = cleanPath(rawPath) || '/';
         let page = pageMap.get(path);
         if (!page) {
            page = {
               path,
               isCited: false,
               status: 'not-cited',
               aiReferralVisitors: 0,
               referredBy: [],
            };
            pageMap.set(path, page);
         }
         return page;
      };

      // Fold AI referrals into per-engine referral tallies, and into pages when
      // (and only when) the provider exposes a landing path.
      const engineMap = new Map<string, AiVisibilityEngine>();
      const ensureEngine = (engine: string, owner: string | null): AiVisibilityEngine => {
         let row = engineMap.get(engine);
         if (!row) {
            row = { engine, owner, status: 'absent', referrals: 0, referredPages: [] };
            engineMap.set(engine, row);
         }
         if (!row.owner && owner) { row.owner = owner; }
         return row;
      };

      aiReferralSources.forEach((s) => {
         const engineLabel = s.engine || s.name || 'Unknown AI';
         const visitors = Number(s.unique_visitors ?? 0);
         const engine = ensureEngine(engineLabel, null);
         engine.referrals += visitors;
         if (s.landing_path) {
            const page = ensurePage(s.landing_path);
            page.isCited = true;
            page.aiReferralVisitors += visitors;
            const existingRef = page.referredBy.find((r) => r.engine === engineLabel);
            if (existingRef) { existingRef.visitors += visitors; } else { page.referredBy.push({ engine: engineLabel, visitors }); }
            if (!engine.referredPages.includes(page.path)) { engine.referredPages.push(page.path); }
         }
      });

      // Resolve per-page status: cited when an AI referral landed there, else not.
      const pages = Array.from(pageMap.values()).map((page) => ({
         ...page,
         status: (page.isCited ? 'ai-cited' : 'not-cited') as PageStatus,
         referredBy: page.referredBy.slice().sort((a, b) => b.visitors - a.visitors),
      }));
      pages.sort((a, b) => b.aiReferralVisitors - a.aiReferralVisitors);

      // Resolve per-engine status. An engine that refers traffic is an advocate.
      const engines = Array.from(engineMap.values()).map((engine) => ({
         ...engine,
         status: (engine.referrals > 0 ? 'advocate' : 'absent') as EngineStatus,
      }));
      engines.sort((a, b) => b.referrals - a.referrals);

      // Summary.
      const totalAIReferrals = aiReferralSources.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
      const advocates = engines.filter((e) => e.status === 'advocate');
      const topAdvocate = advocates.length > 0
         ? advocates.slice().sort((a, b) => b.referrals - a.referrals)[0].engine
         : null;

      const summary: VisibilitySummary = {
         totalAIReferrals,
         topAdvocate,
      };

      // Optional enrichment: when first-party AI behavior is thin (no AI referrals),
      // score the top pages' AI-readiness so the view still says something useful.
      // Never let the audit break the route.
      const dataIsThin = totalAIReferrals === 0;
      let citabilityAudit: CitabilityAudit | null = null;
      if (dataIsThin) {
         try {
            // Seed the audit with whatever pages we know about (cited), plus the
            // root. auditCitability dedupes and caps the set itself.
            const knownPaths = pages.map((p) => p.path);
            citabilityAudit = await auditCitability(domain, knownPaths);
         } catch (auditErr) {
            citabilityAudit = null;
            console.log('[WARN] Citability audit failed for ', domain, auditErr);
         }
      }

      let note: string | null = null;
      if (dataIsThin) {
         note = 'First-party AI referral data is thin for this window, so the per-page view is mostly empty. The '
            + 'citabilityAudit shows how AI-ready the top pages are (a leading indicator). Re-check as the window fills.';
      } else if (!referralLandingAvailable) {
         note = 'AI referrals are reported site-wide by this analytics provider (no per-landing-page detail), so '
            + 'per-page citation cannot be attributed: pages show isCited=false even when the site overall is '
            + 'cited. Engine-level referrals and the totals are still accurate. Use ai_referrals for '
            + 'site-wide AI-engine totals.';
      }

      return res.status(200).json({
         domain,
         period,
         engines,
         pages,
         summary,
         dataIsThin,
         citabilityAudit,
         referralError,
         referralLandingAvailable,
         note,
      });
   } catch (error) {
      console.log('[ERROR] Building AI Visibility for ', domain, error);
      return res.status(400).json({ error: 'Error Building AI Visibility for this Domain.' });
   }
};
