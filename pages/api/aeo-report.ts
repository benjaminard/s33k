import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, ReferralSource } from '../../utils/analytics';
import * as reportCache from '../../utils/report-cache';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * This route NEVER queries an LLM, NEVER embeds/fine-tunes, and NEVER transmits
 * account data to any external model. It only reads the first-party, un-gameable
 * signal s33k already records (AI referral traffic from the analytics provider)
 * and bundles it. Narration happens in the USER's own LLM over MCP. Full trust
 * documentation: SECURITY.md (and the security_facts MCP tool).
 * ============================================================================
 */

/**
 * aeo_report: a single-call AEO (AI-search) snapshot for one domain.
 *
 * GET /api/aeo-report?domain=example.com&period=30d
 *
 * A PREBUILT REPORT bundles the AEO referral signal into one sectioned response
 * the user's LLM narrates, so a marketer gets the whole AI-search picture in one
 * call instead of stitching ai_referrals + ai_visibility by hand. It does NOT call
 * those API routes over HTTP: it reuses the SAME utils and reads the SAME provider
 * the AEO endpoints use, so the numbers match by construction.
 *
 * Sections:
 *   aiReferrals    Which AI engines actually SENT visitors, per engine, with
 *                  counts. Mirrors pages/api/ai-referrals.ts: classifyReferrer
 *                  has already run inside the provider (ReferralSource.isAI /
 *                  .engine), so we filter to AI and aggregate by engine label.
 *   engineSummary  The per-engine outcome view: referral visitors per engine and
 *                  the top advocate.
 *
 * When first-party AEO data is thin (no AI referrals), the `note` says so honestly.
 *
 * Wired-route contract: db.sync, authorize -> 401, GET guard -> 405, per-domain
 * resolveDomainAccess gate -> 403, try/catch -> 400. Degrades gracefully: a thrown
 * referral read sets the referralError field and still returns 200 with the rest
 * of the report intact.
 */

/** Per-engine AI referral row (the outcome: AI engines that sent visitors). */
type AiReferralRow = {
   engine: string,
   visitors: number,
}

/** Per-engine summary row. */
type EngineSummaryRow = {
   engine: string,
   /** advocate = refers traffic; absent = no referrals. */
   status: 'advocate' | 'absent',
   referrals: number,
}

type EngineSummary = {
   totalAIReferrals: number,
   /** The engine doing the most for you (advocate with the most referrals), or null. */
   topAdvocate: string | null,
   engines: EngineSummaryRow[],
}

type AeoReportResponse = {
   domain?: string,
   period?: string,
   aiReferrals?: {
      byEngine: AiReferralRow[],
      totals: { aiVisitors: number, allReferredVisitors: number, aiSharePct: number },
   },
   engineSummary?: EngineSummary,
   // Non-fatal sub-signal errors, surfaced so a partial report is honest.
   referralError?: string | null,
   note?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<AeoReportResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAeoReport(req, res, account);
}

const getAeoReport = async (req: NextApiRequest, res: NextApiResponse<AeoReportResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // Verify the caller owns this domain before exposing any of its data. With
      // MULTI_TENANT off, scopeWhere is {} so this matches the domain by name.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      // Tenant-scoped cache (key begins with the resolved account ID), checked only after the
      // ownership gate so a HIT only ever returns this caller's own report. fresh=1 / nocache=1
      // bypass the read and refill below.
      const cacheKey = reportCache.buildReportCacheKey('aeo-report', req, account);
      if (!reportCache.wantsFresh(req)) {
         const hit = reportCache.get(cacheKey) as AeoReportResponse | undefined;
         if (hit) { return res.status(200).json(hit); }
      }

      // --- Section 1: AI REFERRALS (the outcome). Same read as ai-referrals.ts.
      // The provider has already run classifyReferrer, so ReferralSource carries
      // isAI and the normalized engine label. We keep AI sources and aggregate by
      // engine. A thrown provider read degrades to an empty section + error field.
      let referralError: string | null = null;
      let aiReferralSources: ReferralSource[] = [];
      let allReferredVisitors = 0;
      try {
         const { sources, error: refError } = await getAnalyticsProvider().getReferralSources(domain, period);
         referralError = refError;
         const all = sources || [];
         allReferredVisitors = all.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
         aiReferralSources = all.filter((s) => s.isAI);
      } catch (refErr) {
         referralError = refErr instanceof Error ? refErr.message : String(refErr);
      }

      // Aggregate AI visitors by engine. Per-engine pageviews are NOT surfaced: the first-party
      // provider does not return a per-referrer pageview count, so it would always be 0, a
      // false value (a visitor implies at least one pageview).
      const referralEngineMap = new Map<string, AiReferralRow>();
      aiReferralSources.forEach((s) => {
         const engine = s.engine || s.name || 'Unknown AI';
         const existing = referralEngineMap.get(engine) || { engine, visitors: 0 };
         existing.visitors += Number(s.unique_visitors ?? 0);
         referralEngineMap.set(engine, existing);
      });
      const referralByEngine = Array.from(referralEngineMap.values()).sort((a, b) => b.visitors - a.visitors);
      const aiVisitors = referralByEngine.reduce((sum, r) => sum + r.visitors, 0);
      const aiSharePct = allReferredVisitors > 0 ? Math.round((aiVisitors / allReferredVisitors) * 1000) / 10 : 0;

      // --- Section 2: ENGINE SUMMARY (per-engine outcome). An engine that refers
      // traffic is an advocate; neither is "absent".
      const engines: EngineSummaryRow[] = referralByEngine.map((r) => ({
         engine: r.engine,
         status: (r.visitors > 0 ? 'advocate' : 'absent') as EngineSummaryRow['status'],
         referrals: r.visitors,
      }));

      const totalAIReferrals = aiVisitors;
      const advocates = engines.filter((e) => e.status === 'advocate');
      const topAdvocate = advocates.length > 0
         ? advocates.slice().sort((a, b) => b.referrals - a.referrals)[0].engine
         : null;

      const engineSummary: EngineSummary = { totalAIReferrals, topAdvocate, engines };

      // Honest note when first-party AEO data is thin.
      let note: string | null = null;
      if (totalAIReferrals === 0) {
         note = 'First-party AEO data is thin for this window: no AI referral traffic recorded. AI referral '
            + 'traffic to most sites builds slowly, so an empty result early on is expected. Make key pages '
            + 'answer-ready (clear answers up top, structured claims, an llms.txt) and re-check as the window fills.';
      }

      const payload: AeoReportResponse = {
         domain,
         period,
         aiReferrals: {
            byEngine: referralByEngine,
            totals: { aiVisitors, allReferredVisitors, aiSharePct },
         },
         engineSummary,
         referralError,
         note,
         error: null,
      };
      // Only successful reports are cached (the catch below returns its own 400 payload).
      reportCache.set(cacheKey, payload);
      return res.status(200).json(payload);
   } catch (error) {
      console.log('[ERROR] Building AEO Report for ', domain, error);
      return res.status(400).json({ error: 'Error Building AEO Report for this Domain.' });
   }
};
