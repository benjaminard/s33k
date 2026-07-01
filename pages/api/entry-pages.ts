/**
 * GET /api/entry-pages
 *
 * ENTRY-PAGE (landing-page) analysis: the cross-pillar join nobody else offers.
 *
 * Entry pages are where a session STARTS, so they are the acquisition surface and
 * behave differently from deeper pages. For each entry page this route joins:
 *   - the page's first-touch SOURCE split (direct / referral / search / ai), from
 *     the first-party analytics provider's getEntryPages (utils/analytics.ts);
 *   - the page's tracked SEO keywords + current Google rank, from the Keyword model
 *     (matched by target_page, exactly like page_scoreboard);
 *   - the page's AI referrals (AI-engine-referred entries), from the referral
 *     sources when there is per-landing-page detail;
 * and synthesizes a STATUS (utils/entry-page-status.ts) that connects "we rank for
 * X" to "X actually LANDS people": working / ranking-not-landing / brand-direct /
 * ai-landing / opportunity.
 *
 * This is a SEGMENTATION (entry pages by source class) plus a JOIN to existing
 * per-page keyword/rank/AI data, NOT new data collection. It is honest where the
 * data is thin: when only a site-wide referrer mix is available, per-page source
 * splits are APPROXIMATED from that mix (sourcesNote flags it).
 *
 * Per-page AI-search landing counts are EXACT when we have first-party data:
 * s33k sessionizes its own s33k_event rows, takes the sessions classified to the
 * 'ai' channel, and groups them by landing page. That answers "which pages did AI
 * search land on" exactly, from data we own. aiReferralNote clears in that case.
 * Only when there are NO first-party AI sessions at all do we fall back to a
 * per-source landing_path (rare) or to 0 with the note, staying honest.
 *
 * Never 500s on a sub-signal failure: a referral or keyword read that fails degrades
 * that one signal (surfaced as referralError / a zeroed signal) while the entry-page
 * table still returns.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { cleanPath } from '../../utils/clean-path';
import { periodStartMs } from '../../utils/period';
import { EventLike } from '../../utils/sessionize';
import { aiLandingFromSessions } from '../../utils/ai-landing';
import { getAnalyticsProvider, ReferralSource, EntryPageSources } from '../../utils/analytics';
import { classifyEntryPage, EntryPageStatus, ENTRY_PAGE_STATUS_LABELS } from '../../utils/entry-page-status';

type EntryPageKeyword = {
   keyword: string,
   rank: number,
}

type EntryPageRecord = {
   page: string,
   pathClean: string,
   entries: number,
   sources: EntryPageSources,
   sourcesApproximated: boolean,
   keywords: EntryPageKeyword[],
   aiReferrals: number,
   status: EntryPageStatus,
}

type EntryPagesSummary = {
   topLandingPages: { page: string, entries: number, status: EntryPageStatus }[],
   biggestRankingNotLandingGap: { page: string, entries: number, keywords: number } | null,
   aiLandingPages: { page: string, entries: number, aiReferrals: number }[],
   statusCounts: Record<EntryPageStatus, number>,
}

/**
 * Truncation metadata for the default summary-first response. The full per-page array on a real
 * site (example.com) is thousands of rows / ~87k chars, which exceeds the MCP token limit, so the
 * default response returns only the top-N entryPages plus this meta. The summary + statusCounts are
 * always computed over ALL records BEFORE truncation, so whole-site accuracy is preserved and the
 * "which pages did AI search land on" question is answerable from the summary alone. Pass detail=true
 * to get every row.
 */
type EntryPagesMeta = {
   totalEntryPages: number,
   returnedEntryPages: number,
   truncated: boolean,
   hint: string,
}

type EntryPagesResponse = {
   domain?: string,
   period?: string,
   summary?: EntryPagesSummary,
   statusLegend?: Record<EntryPageStatus, string>,
   entryPages?: EntryPageRecord[],
   meta?: EntryPagesMeta,
   sourcesNote?: string | null,
   aiReferralNote?: string | null,
   analyticsError?: string | null,
   referralError?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<EntryPagesResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getEntryPages(req, res, account);
}

const getEntryPages = async (req: NextApiRequest, res: NextApiResponse<EntryPagesResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // detail=true returns the full per-page array (use sparingly: thousands of rows on a real site).
   // The default is summary-first: top-N entry pages by entries, bounded so the response stays under
   // the MCP token limit. limit clamps to 1..200 (default 20); the summary always covers ALL pages.
   const detail = req.query.detail === 'true' || req.query.detail === '1';
   const rawLimit = Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '', 10);
   const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 20;

   // Ownership gate (identical to scoreboard.ts): verify the caller owns this domain
   // before exposing any of its data. With MULTI_TENANT off, scopeWhere returns {}.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      const provider = getAnalyticsProvider();

      // 1. Entry pages + their (approximated) first-touch source split. The provider
      // never throws; a failure comes back as an error string with an empty list.
      const entryResult = await provider.getEntryPages(domain, period);
      const analyticsError = entryResult.error;

      // 2. Per-page AI-search landing counts. PREFER first-party sessions: sessionize this
      // domain's scoped s33k_event rows, take the 'ai'-channel sessions, and group by landing
      // page. That is an EXACT count of AI-search-first entries per page, from data we own, with
      // no per-source landing_path needed. Only when there are zero first-party
      // AI sessions do we fall back to a per-source landing_path, then to 0 + a note.
      // A failure on either path NEVER breaks this route.
      let aiVisitorsByLanding = new Map<string, number>();
      let referralError: string | null = null;
      let aiLandingExact = false;
      try {
         const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
         const eventRows: S33kEvent[] = await S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         });
         const { byLanding, totalAiSessions } = aiLandingFromSessions(eventRows.map((r) => r.get({ plain: true }) as EventLike));
         if (totalAiSessions > 0) {
            aiVisitorsByLanding = byLanding;
            aiLandingExact = true;
         }
      } catch (evErr) {
         console.log('[WARN] entry-pages first-party AI-landing read failed for ', domain, evErr);
      }
      // Fallback: only when we have no first-party AI sessions, try a per-source
      // landing_path (usually not present, so this typically stays empty).
      let aiReferralLandingAvailable = false;
      if (!aiLandingExact) {
         try {
            const { sources, error: refError } = await provider.getReferralSources(domain, period);
            referralError = refError;
            (sources || []).filter((s: ReferralSource) => s.isAI).forEach((s) => {
               if (s.landing_path) {
                  aiReferralLandingAvailable = true;
                  const key = cleanPath(s.landing_path);
                  aiVisitorsByLanding.set(key, (aiVisitorsByLanding.get(key) || 0) + Number(s.unique_visitors ?? 0));
               }
            });
         } catch (refErr) {
            referralError = refErr instanceof Error ? refErr.message : String(refErr);
            aiVisitorsByLanding = new Map<string, number>();
         }
      }
      // The note clears whenever the per-page AI counts are exact: first-party sessions (exact) or
      // a provider landing_path (exact). It only stays set when neither is available.
      const aiReferralNote = (aiLandingExact || aiReferralLandingAvailable)
         ? null
         : 'AI-referral data has no per-landing-page detail from this provider and no first-party AI sessions yet, so '
            + 'aiReferrals is 0 per page; the ai-landing status still uses the approximated per-page AI source share. '
            + 'Install the s33k.js tracking script for exact per-page AI-search landing counts, or use ai_referrals for '
            + 'site-wide totals.';

      // 3. Tracked keywords for this domain, grouped by normalized target_page path
      // (same join as page_scoreboard). A keyword read failure degrades to "no tracked
      // keywords" rather than failing the route.
      const keywordsByPath = new Map<string, EntryPageKeyword[]>();
      try {
         const allKeywords: Keyword[] = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
         const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));
         keywords.forEach((kw) => {
            const targetClean = cleanPath(kw.target_page || '');
            if (!targetClean) { return; }
            const list = keywordsByPath.get(targetClean) || [];
            list.push({ keyword: kw.keyword, rank: kw.position });
            keywordsByPath.set(targetClean, list);
         });
      } catch (kwErr) {
         console.log('[WARN] entry-pages keyword join failed for ', domain, kwErr);
      }

      // 4. Build the per-entry-page records, joining all three signals + the status.
      const entryPages: EntryPageRecord[] = entryResult.pages.map((p) => {
         const matchedKeywords = keywordsByPath.get(p.pathClean) || [];
         const aiReferrals = aiVisitorsByLanding.get(p.pathClean) || 0;
         // AI-traffic signal: an exact per-page AI referral (when available) OR a
         // non-trivial approximated AI source share. Either is "AI is landing people here".
         const hasAiTraffic = aiReferrals > 0 || p.sources.ai > 0;
         // Non-direct traffic = search or referral first-touch (the search/referral land path).
         const hasNonDirectTraffic = p.sources.search > 0 || p.sources.referral > 0;
         const status = classifyEntryPage({
            hasTrackedKeywords: matchedKeywords.length > 0,
            hasNonDirectTraffic,
            hasAiTraffic,
         });
         return {
            page: p.page,
            pathClean: p.pathClean,
            entries: p.entries,
            sources: p.sources,
            sourcesApproximated: p.sourcesApproximated,
            keywords: matchedKeywords,
            aiReferrals,
            status,
         };
      });
      entryPages.sort((a, b) => b.entries - a.entries);

      // 5. Top-level summary: the headline landing pages, the biggest
      // ranking-not-landing gap, and the AI-landing pages.
      const statusCounts = entryPages.reduce((acc, p) => {
         acc[p.status] += 1;
         return acc;
      }, { working: 0, 'ranking-not-landing': 0, 'brand-direct': 0, 'ai-landing': 0, opportunity: 0 } as Record<EntryPageStatus, number>);

      // Biggest ranking-not-landing gap = the page that ranks but lands fewest entries.
      // It is the clearest "you rank, it just is not landing" signal. Lowest entries wins.
      const rankingNotLanding = entryPages
         .filter((p) => p.status === 'ranking-not-landing')
         .sort((a, b) => a.entries - b.entries);
      const gap = rankingNotLanding[0]
         ? { page: rankingNotLanding[0].page, entries: rankingNotLanding[0].entries, keywords: rankingNotLanding[0].keywords.length }
         : null;

      // Summary is computed over ALL entryPages (before any truncation) so it stays whole-site
      // accurate. topLandingPages and aiLandingPages slice to 10 so "which pages did AI search land
      // on" is answerable from the summary alone, without expanding the full per-page array.
      const summary: EntryPagesSummary = {
         topLandingPages: entryPages.slice(0, 10).map((p) => ({ page: p.page, entries: p.entries, status: p.status })),
         biggestRankingNotLandingGap: gap,
         aiLandingPages: entryPages
            .filter((p) => p.status === 'ai-landing')
            .slice(0, 10)
            .map((p) => ({ page: p.page, entries: p.entries, aiReferrals: p.aiReferrals })),
         statusCounts,
      };

      // Default response is summary-first and bounded: return the top-N entry pages plus meta that
      // explains the truncation and points to detail=true for the full array. detail=true returns
      // every row with truncated:false. The summary above already covers all pages either way.
      const totalEntryPages = entryPages.length;
      const returnedPages = detail ? entryPages : entryPages.slice(0, limit);
      const truncated = !detail && totalEntryPages > returnedPages.length;
      const meta: EntryPagesMeta = {
         totalEntryPages,
         returnedEntryPages: returnedPages.length,
         truncated,
         hint: truncated
            ? `entryPages is truncated to the top ${returnedPages.length} of ${totalEntryPages} pages by entries; the summary and `
               + 'statusCounts cover ALL pages. Pass detail=true for the full per-page array, or limit=N (1..200) to change the cap.'
            : 'entryPages contains every entry page for this period.',
      };

      // summary + statusLegend are ordered BEFORE entryPages in the JSON so a reader sees the
      // whole-site picture first, then the (bounded) per-page detail.
      return res.status(200).json({
         domain,
         period,
         summary,
         statusLegend: ENTRY_PAGE_STATUS_LABELS,
         entryPages: returnedPages,
         meta,
         sourcesNote: entryResult.sourcesNote,
         aiReferralNote,
         analyticsError,
         referralError,
      });
   } catch (error) {
      console.log('[ERROR] Building Entry Pages for ', domain, error);
      return res.status(400).json({ error: 'Error Building Entry Pages for this Domain.' });
   }
};
