/**
 * Compact SERP shaping for keyword WRITE responses (POST/PUT /api/keywords).
 *
 * WHY THIS EXISTS (LLM ergonomics): the stored `lastResult` is a full 100-position SERP array in
 * which ~90 rows are empty `skipped` placeholders (see buildFullResults in utils/scraper.ts). The
 * update/create responses used to echo that whole array per keyword, which is pure noise to the
 * caller: they asked to set a target page or a sticky flag, not to re-read the SERP. The response
 * now carries `serpTop` (the top 3 real results: position, url, title) plus `serpResultCount`
 * instead. STORAGE IS UNCHANGED: keyword.lastResult keeps the full array on disk and every other
 * reader of the stored data is untouched; this shapes the write RESPONSE only.
 *
 * Dependency-free on purpose (no DB models) so it is safe to import from any route or test.
 */

export type SerpTopEntry = { position: number, url: string, title: string };

export type SerpResponseSummary = { serpTop: SerpTopEntry[], serpResultCount: number };

/** How many real SERP entries the write response keeps. */
export const SERP_TOP_COUNT = 3;

/**
 * Summarize a parsed lastResult array (KeywordLastResult[]) into the compact response form.
 * Skipped placeholder rows (no url, `skipped: true`) never count and never appear.
 */
export const serpSummary = (lastResult: unknown): SerpResponseSummary => {
   const rows = Array.isArray(lastResult) ? lastResult : [];
   const real = rows.filter((r) => r && typeof r === 'object' && !(r as { skipped?: boolean }).skipped && (r as { url?: string }).url);
   return {
      serpTop: real.slice(0, SERP_TOP_COUNT).map((r) => ({
         position: (r as { position: number }).position,
         url: (r as { url: string }).url,
         title: (r as { title?: string }).title || '',
      })),
      serpResultCount: real.length,
   };
};

/** A keyword as returned by the WRITE responses: lastResult replaced by its compact summary. */
export type CompactKeyword = Omit<KeywordType, 'lastResult'> & SerpResponseSummary;

/** Replace a parsed keyword's lastResult echo with serpTop + serpResultCount. */
export const compactKeywordResponse = (keyword: KeywordType): CompactKeyword => {
   const { lastResult, ...rest } = keyword;
   return { ...rest, ...serpSummary(lastResult) };
};
