import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import type Account from '../../database/models/account';
import { findStrikingDistance, StrikingInput, StrikingKeyword } from '../../utils/striking-distance';
import * as reportCache from '../../utils/report-cache';

// GET /api/seo-report?domain=&min=4&max=30&moversLimit=5
//
// A PREBUILT REPORT: the whole SEO picture for a domain in ONE call, so the user's LLM can narrate
// the full snapshot without the marketer chaining four separate tool calls. It does NOT call other
// API routes over HTTP. It reads the Keyword table ONCE and bundles four sections out of those rows:
//
//   summary         - the rank-distribution headline (how many keywords sit in top 3 / top 10 /
//                     page one / off page one entirely), so "how am I doing overall" is answerable
//                     before any drill-down.
//   strikingDistance - the quick-win to-do list, REUSING findStrikingDistance (positions 4 to 30,
//                     sorted by closeness then improvement). No logic is duplicated here.
//   topMovers       - the biggest rank IMPROVEMENTS and the biggest DROPS over each keyword's tracked
//                     history, the "what changed and where do I lean in / defend" view.
//   rankingPages    - tracked keywords grouped by their target_page, so a marketer sees each page and
//                     exactly which terms + positions it holds.
//
// Pure query over Keyword rows. No page fetch, no analytics provider, no LLM (the trust property). The
// report returns structured sections for the user's own LLM to narrate.

// One keyword as it appears inside a ranking page group: the term, its live position, and the url it
// ranks with. Kept minimal so the page grouping stays readable.
type PageKeyword = {
   keyword: string,
   position: number,
   url: string,
};

// A mover is a keyword whose tracked history shows a real start->recent change. delta is recent
// minus start, so NEGATIVE means improved (climbed toward position 1) and POSITIVE means dropped.
type Mover = {
   keyword: string,
   position: number,
   url: string,
   startPosition: number,
   recentPosition: number,
   // recentPosition - startPosition. Negative == improved, positive == dropped. The two mover
   // lists are this same value sorted opposite ways.
   delta: number,
   historyPoints: number,
};

type RankingPage = {
   // The keyword.target_page value the keywords were grouped under. Empty string is bucketed under
   // an explicit '(no target page)' label so untargeted keywords are never silently dropped.
   target_page: string,
   keywordCount: number,
   keywords: PageKeyword[],
};

type SeoSummary = {
   totalKeywords: number,
   // Rank buckets. These are NOT mutually exclusive on purpose: top3 keywords are also in top10 and
   // pageOne, mirroring how a marketer reads "I have N in the top 3, N in the top 10". notInTop100
   // is the disjoint tail (position 0 == not found in the top 100 results) EXCLUDING rank-pending
   // keywords whose first Google check has not landed yet (see rankingsPending below).
   inTop3: number,
   inTop10: number,
   onPageOne: number,
   notInTop100: number,
   // Keywords whose first rank check has not landed yet (updating === true). A freshly added keyword
   // is created updating:true with position 0, so it would otherwise be miscounted as "not in the top
   // 100". It is NOT a real "not ranked": the first check is still running. Counted here instead and
   // excluded from notInTop100 so a brand-new domain never reads as "0 ranked, N not in top 100".
   rankingsPending: number,
};

type SeoReportResponse = {
   domain?: string,
   summary?: SeoSummary,
   strikingDistance?: StrikingKeyword[],
   topMovers?: { improvements: Mover[], drops: Mover[] },
   rankingPages?: RankingPage[],
   note?: string,
   error?: string | null,
};

// SerpBear stores a keyword url as a JSON array (best-match first) or, on legacy rows, a bare
// string. Same defensive parse the striking-distance util uses; duplicated here only because it is a
// two-line pure helper local to building the page/mover rows, not shared report logic.
const firstUrl = (raw: string): string => {
   const s = String(raw || '').trim();
   if (!s) { return ''; }
   try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) { return parsed.length ? String(parsed[0] || '') : ''; }
      if (typeof parsed === 'string') { return parsed; }
      return '';
   } catch {
      return s;
   }
};

// history is a JSON string of { 'YYYY-MM-DD': position }. Return the chronological positions, oldest
// first, dropping non-positive values (0 means "not in the top 100 that day", not a real rank, so it
// would distort a delta). Empty array when history is missing/invalid.
const historyPositions = (raw: string): Array<[string, number]> => {
   const s = String(raw || '').trim();
   if (!s) { return []; }
   try {
      const parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return []; }
      return Object.entries(parsed as Record<string, unknown>)
         .map(([date, pos]) => [date, Number(pos)] as [string, number])
         .filter(([, pos]) => Number.isFinite(pos) && pos > 0)
         .sort((a, b) => a[0].localeCompare(b[0]));
   } catch {
      return [];
   }
};

// refresh.ts stamps lastUpdateError as the string 'false' (default / cleared on success) or a JSON
// blob { date, error, scraper } on a failed scrape. Return the human error message inside the blob,
// or '' when the keyword has no error. These are the only two written forms; '' and '{}' are treated
// as no-error for safety (mirrors the NON_ERROR_SENTINELS in utils/scraper.ts).
const lastUpdateErrorMessage = (raw: unknown): string => {
   const s = String(raw || '').trim();
   if (!s || s === 'false' || s === '{}') { return ''; }
   try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
         return String((parsed as Record<string, unknown>).error || '').trim();
      }
      // A bare non-JSON string is itself the error message (legacy / defensive).
      return s;
   } catch {
      return s;
   }
};

// Does a scrape error message indicate the SERP SOURCE is unconfigured, over quota, or unauthorized
// (a whole-instance problem), rather than a normal "this one keyword is not ranking"? These are the
// strings worth surfacing as ONE honest note instead of a wall of position-0 "not ranked" keywords.
// Matches: no scraper client (unconfigured), quota / rate-limit / 429, and auth (401 / 403 / invalid
// key) signals from any scraper (Serper and friends). Substring + case-insensitive on purpose so a
// provider wording change does not silently stop matching.
const isScraperConfigError = (message: string): boolean => {
   const m = message.toLowerCase();
   if (!m) { return false; }
   return m.includes('no scraper client')
      || m.includes('quota') || m.includes('rate limit') || m.includes('rate-limit') || m.includes('429')
      || m.includes('unauthorized') || m.includes('401') || m.includes('403')
      // Match only the specific API-KEY problem phrasings, NOT the bare substring 'api key' (which a
      // benign message could contain), so a real "no/missing/invalid api key" is caught without
      // false-positiving on any sentence that merely mentions an api key.
      || m.includes('no api key') || m.includes('missing api key') || m.includes('invalid api key') || m.includes('invalid key')
      || m.includes('forbidden') || m.includes('not authorized') || m.includes('authentication');
};

// Clamp a striking-window bound to a sane Google-rank range (1..100). Mirrors striking-distance.ts.
const parseBound = (raw: unknown, fallback: number): number => {
   const n = parseInt(String(raw), 10);
   if (!Number.isFinite(n)) { return fallback; }
   return Math.min(100, Math.max(1, n));
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<SeoReportResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getSeoReport(req, res, account);
}

const getSeoReport = async (req: NextApiRequest, res: NextApiResponse<SeoReportResponse>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   // Verify the caller owns this domain before reading any of its keyword data. scopeWhere returns
   // {} for admin / MULTI_TENANT-off callers (match any domain) and limits a tenant to their rows.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   // Tenant-scoped cache (key begins with the resolved account ID), built only after the ownership
   // gate so a HIT only ever returns this caller's own report. fresh=1 / nocache=1 bypass + refill.
   const cacheKey = reportCache.buildReportCacheKey('seo-report', req, account);
   if (!reportCache.wantsFresh(req)) {
      const hit = reportCache.get(cacheKey) as SeoReportResponse | undefined;
      if (hit) { return res.status(200).json(hit); }
   }

   const min = parseBound(q.min, 4);
   const max = Math.max(min, parseBound(q.max, 30));
   // How many movers to show per side (improvements / drops). Bounded so a huge keyword set cannot
   // return an unbounded payload; default 5 is the "top few" a standup wants.
   const moversLimit = Math.min(50, Math.max(1, parseInt(String(q.moversLimit), 10) || 5));

   try {
      // ONE read of the Keyword table feeds all four sections. We pull target_page (for grouping)
      // on top of the columns striking-distance needs, and reuse the raw rows for summary + movers.
      const keywordRows = await Keyword.findAll({
         where: { domain, ...scopeWhere(account) },
         attributes: ['keyword', 'position', 'url', 'history', 'target_page', 'updating', 'lastUpdateError'],
      });
      const plain = keywordRows.map((k) => k.get({ plain: true }) as Record<string, unknown>);

      // --- summary: the rank-distribution headline over every tracked keyword. ---
      const totalKeywords = plain.length;
      let inTop3 = 0; let inTop10 = 0; let onPageOne = 0; let notInTop100 = 0; let rankingsPending = 0;
      // How many tracked keywords carry a scraper-config error (unconfigured / quota / auth). When
      // most of the set is failing this way, we surface ONE honest note instead of treating every
      // position-0 row as "not ranked" (it is the SERP source that is broken, not the rankings).
      let scraperConfigErrors = 0;
      for (const p of plain) {
         const pos = Number(p.position) || 0;
         // A keyword is RANK-PENDING when its first Google check has not landed yet (updating===true).
         // Fresh keywords are created updating:true with position 0, so without this guard they would
         // be miscounted as "not in the top 100". Count them as pending and exclude from notInTop100.
         const pending = p.updating === true;
         const errMessage = lastUpdateErrorMessage(p.lastUpdateError);
         if (errMessage && isScraperConfigError(errMessage)) {
            scraperConfigErrors += 1;
         }
         if (pending) {
            rankingsPending += 1; // first check still running, not a real "not ranked"
         } else if (pos === 0) {
            notInTop100 += 1; // position 0 == not found in the top 100 (and the check has landed)
         } else {
            if (pos <= 3) { inTop3 += 1; }
            if (pos <= 10) { inTop10 += 1; onPageOne += 1; } // page one is the top 10 results
         }
      }
      const summary: SeoSummary = { totalKeywords, inTop3, inTop10, onPageOne, notInTop100, rankingsPending };

      // --- strikingDistance: REUSE the shared util, no duplicated quick-win logic. ---
      const strikingInput: StrikingInput[] = plain.map((p) => ({
         keyword: String(p.keyword || ''),
         position: Number(p.position) || 0,
         url: String(p.url || ''),
         history: String(p.history || ''),
      }));
      const strikingDistance = findStrikingDistance(strikingInput, min, max);

      // --- topMovers: biggest start->recent improvements and drops over tracked history. ---
      // Only keywords with >= 2 valid history points have a real movement to report; the rest have
      // no measurable change and are excluded rather than shown as a fake 0 delta.
      const movers: Mover[] = [];
      for (const p of plain) {
         const pairs = historyPositions(String(p.history || ''));
         // Only keywords with >= 2 valid history points have a real movement; a net-zero delta is
         // not a mover either way, so both are skipped without a continue.
         if (pairs.length >= 2) {
            const startPosition = pairs[0][1];
            const recentPosition = pairs[pairs.length - 1][1];
            const delta = recentPosition - startPosition; // negative == improved, positive == dropped
            if (delta !== 0) {
               movers.push({
                  keyword: String(p.keyword || ''),
                  position: Number(p.position) || 0,
                  url: firstUrl(String(p.url || '')),
                  startPosition,
                  recentPosition,
                  delta,
                  historyPoints: pairs.length,
               });
            }
         }
      }
      // improvements: most-negative delta first (biggest climb). drops: most-positive delta first
      // (biggest fall). Two views of the same list, sorted opposite ways, each capped to moversLimit.
      const improvements = [...movers].filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, moversLimit);
      const drops = [...movers].filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, moversLimit);

      // --- rankingPages: tracked keywords grouped by their target_page. ---
      // Empty target_page is bucketed under an explicit label so nothing is silently dropped.
      const NO_PAGE = '(no target page)';
      const byPage = new Map<string, PageKeyword[]>();
      for (const p of plain) {
         const key = String(p.target_page || '').trim() || NO_PAGE;
         const list = byPage.get(key) || [];
         list.push({ keyword: String(p.keyword || ''), position: Number(p.position) || 0, url: firstUrl(String(p.url || '')) });
         byPage.set(key, list);
      }
      const rankingPages: RankingPage[] = Array.from(byPage.entries())
         .map(([target_page, kws]) => ({
            target_page,
            keywordCount: kws.length,
            // Within a page, show the best-ranking terms first. position 0 (not in top 100) sorts to
            // the bottom by treating it as worse than any real rank.
            keywords: kws.sort((a, b) => (a.position || 999) - (b.position || 999)),
         }))
         // Pages with the most tracked keywords first; the busiest pages are usually the priority.
         .sort((a, b) => b.keywordCount - a.keywordCount);

      // "Most" tracked keywords failing with a config error means the SERP source itself is the
      // problem, so lead with that honest note rather than a wall of position-0 "not ranked".
      const scraperFailing = totalKeywords > 0 && scraperConfigErrors > totalKeywords / 2;

      let note: string;
      if (totalKeywords === 0) {
         note = `No keywords are tracked for ${domain} yet. Add keywords so the SEO report has rank data to summarize.`;
      } else if (scraperFailing) {
         // Honest, single explanation. Do NOT name the provider in this user-facing string.
         note = 'Rank checks are failing: the SERP source is unconfigured or over quota. '
            + `${scraperConfigErrors} of ${totalKeywords} tracked keyword(s) could not be checked, so their positions are not reliable. `
            + 'Configure or refill the SERP source, then re-ask.';
      } else if (rankingsPending > 0) {
         // Lead with the pending state so a brand-new domain never reads as "0 ranked, N not in top 100".
         note = `First rank check is running for ${rankingsPending} keyword(s); results usually within minutes, re-ask shortly. `
            + `${onPageOne} on page one (${inTop3} in the top 3), ${strikingDistance.length} in striking distance `
            + `(positions ${min} to ${max}), ${notInTop100} not in the top 100. `
            + 'Work strikingDistance first, then read topMovers for what changed and rankingPages for per-page coverage.';
      } else {
         note = `${totalKeywords} tracked keyword(s): ${onPageOne} on page one (${inTop3} in the top 3), `
            + `${strikingDistance.length} in striking distance (positions ${min} to ${max}), ${notInTop100} not in the top 100. `
            + 'Work strikingDistance first, then read topMovers for what changed and rankingPages for per-page coverage.';
      }

      const payload: SeoReportResponse = {
         domain,
         summary,
         strikingDistance,
         topMovers: { improvements, drops },
         rankingPages,
         note,
         error: null,
      };
      // Only successful reports are cached (error paths return before here).
      reportCache.set(cacheKey, payload);
      return res.status(200).json(payload);
   } catch (error) {
      console.log('[ERROR] Building SEO Report for ', domain, error);
      return res.status(400).json({ error: 'Error Building SEO Report for this Domain.' });
   }
};
