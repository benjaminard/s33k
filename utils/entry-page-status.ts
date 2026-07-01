/**
 * Entry-page status classification: the synthesis at the heart of the entry_pages
 * feature. It is a PURE function so it is independently testable and so the route
 * and the MCP tool share exactly one definition of what each status means.
 *
 * An ENTRY page is where a session STARTS: the acquisition surface. For each one
 * the feature joins three already-existing signals:
 *   - whether s33k tracks ranking keywords for the page (Keyword.target_page/domain),
 *   - whether the page gets non-direct entry traffic (search/referral first-touch),
 *   - whether AI search is a meaningful first-touch source (the AI classifier).
 *
 * The classifier turns that join into one of five statuses a marketer can act on.
 * The cross-pillar value is connecting "we rank for X" to "X actually LANDS people":
 * a page can rank and never land (a gap), or land hard with no tracked rank
 * (brand-driven), or land from AI specifically.
 */

/** The five mutually-exclusive entry-page statuses, most-actionable framing. */
export type EntryPageStatus =
   | 'working'
   | 'ranking-not-landing'
   | 'brand-direct'
   | 'ai-landing'
   | 'opportunity';

/** The three boolean signals the classification reasons over. */
export type EntryPageSignals = {
   /** s33k tracks at least one ranking keyword whose target page is this page. */
   hasTrackedKeywords: boolean,
   /** This page gets non-direct entry traffic (search or referral first-touch). */
   hasNonDirectTraffic: boolean,
   /** AI search is a meaningful first-touch source for this page. */
   hasAiTraffic: boolean,
};

/**
 * Classify one entry page from its three signals. Pure; never throws.
 *
 * Precedence (first match wins), chosen so the most decision-useful label surfaces:
 *   1. ai-landing            AI search is a meaningful first-touch source. Checked
 *                            FIRST because "AI is landing people here" is the
 *                            highest-signal, newest thing a marketer wants to see,
 *                            even when the page also ranks or has other traffic.
 *   2. working               Ranks AND lands from search/referral. The healthy state.
 *   3. ranking-not-landing   Ranks but gets little/no non-direct entry traffic. The
 *                            clearest gap to fix (you rank, it just is not landing).
 *   4. brand-direct          Lands from non-direct traffic but s33k tracks no rank.
 *                            Brand/referral-driven, not search-driven.
 *   5. opportunity           Entry traffic but neither ranking nor AI. Where to invest.
 *
 * @param {EntryPageSignals} signals - The three joined booleans for the page.
 * @returns {EntryPageStatus}
 */
export const classifyEntryPage = (signals: EntryPageSignals): EntryPageStatus => {
   const hasKw = !!signals.hasTrackedKeywords;
   const hasNonDirect = !!signals.hasNonDirectTraffic;
   const hasAi = !!signals.hasAiTraffic;

   if (hasAi) { return 'ai-landing'; }
   if (hasKw && hasNonDirect) { return 'working'; }
   if (hasKw && !hasNonDirect) { return 'ranking-not-landing'; }
   if (!hasKw && hasNonDirect) { return 'brand-direct'; }
   return 'opportunity';
};

/** Human-readable one-liners for each status, surfaced alongside the code in the API/MCP. */
export const ENTRY_PAGE_STATUS_LABELS: Record<EntryPageStatus, string> = {
   working: 'Ranks AND is a real landing page from search/referral.',
   'ranking-not-landing': 'Tracks ranking keywords but gets little or no entry traffic (a gap to fix).',
   'brand-direct': 'Lands plenty of direct/referral entries but has no tracked ranking (brand-driven, not search-driven).',
   'ai-landing': 'AI search is a meaningful first-touch source for this page.',
   opportunity: 'Has entry traffic but neither ranking nor AI (where to invest).',
};

export default classifyEntryPage;
