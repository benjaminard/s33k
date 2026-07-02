/**
 * Summary-first shaping for the Search Console insight response (GET /api/insight).
 *
 * WHY THIS EXISTS (LLM ergonomics): the MCP tool surface is the product and an LLM context window
 * is its primary consumer. The raw insight payload on a real property is unbounded (hundreds of
 * mostly-zero-click keyword rows plus full pages/countries/days arrays, ~113KB observed), which
 * overflowed the consuming LLM on its first real use. The default response is therefore bounded
 * and ranked, mirroring the entry-pages conventions exactly: bounded default, clamped limit param,
 * detail=true escape hatch, and a meta block (totals, truncated, hint) so the LLM knows what was
 * cut and how to get more.
 *
 * Dependency-free on purpose (no DB models, no route imports) so it stays unit-testable and safe
 * to import anywhere.
 */

export const INSIGHT_DEFAULT_TOP_KEYWORDS = 25;
export const INSIGHT_DEFAULT_UNTAPPED_KEYWORDS = 15;
export const INSIGHT_DEFAULT_TOP_PAGES = 15;
export const INSIGHT_TOP_COUNTRIES = 10;
export const INSIGHT_MAX_LIMIT = 200;
// "Low-click" for the untapped-demand view: rows with at most this many clicks. These are the
// keywords Google shows you for (impressions) that earn almost no clicks, i.e. the demand a
// marketer mines for content/title work.
export const INSIGHT_LOW_CLICK_MAX = 1;

export type InsightKeywordRow = {
   keyword: string,
   clicks: number,
   impressions: number,
   ctr: number,
   position: number,
};

export type InsightPageRow = {
   page: string,
   clicks: number,
   impressions: number,
   ctr: number,
   position: number,
};

export type InsightCountryRow = {
   country: string,
   clicks: number,
   impressions: number,
   ctr: number,
   position: number,
};

export type InsightDayRow = {
   date: string,
   clicks: number,
   impressions: number,
   position: number,
};

export type InsightSummaryMeta = {
   totals: { keywords: number, pages: number, countries: number, days: number },
   truncated: boolean,
   hint: string,
};

export type InsightSummary = {
   stats: { clicks: number, impressions: number, ctr: number, position: number, window: string },
   topKeywordsByClicks: InsightKeywordRow[],
   untappedKeywords: InsightKeywordRow[],
   topPages: InsightPageRow[],
   topCountries: InsightCountryRow[],
   days: InsightDayRow[],
   meta: InsightSummaryMeta,
};

const round = (value: number, places: number): number => {
   const factor = 10 ** places;
   return Math.round((Number(value) || 0) * factor) / factor;
};

const keywordRow = (item: SCInsightItem): InsightKeywordRow => ({
   keyword: item.keyword || '',
   clicks: item.clicks,
   impressions: item.impressions,
   ctr: round(item.ctr, 4),
   position: round(item.position, 1),
});

const pageRow = (item: SCInsightItem): InsightPageRow => ({
   page: item.page || '',
   clicks: item.clicks,
   impressions: item.impressions,
   ctr: round(item.ctr, 4),
   position: round(item.position, 1),
});

const countryRow = (item: SCInsightItem): InsightCountryRow => ({
   country: item.country || '',
   clicks: item.clicks,
   impressions: item.impressions,
   ctr: round(item.ctr, 4),
   position: round(item.position, 1),
});

/** Aggregate clicks/impressions/ctr/position over rows, position weighted by impressions. */
const aggregate = (rows: { clicks: number, impressions: number, position: number }[]) => {
   let clicks = 0;
   let impressions = 0;
   let weightedPosition = 0;
   rows.forEach((r) => {
      clicks += Number(r.clicks) || 0;
      impressions += Number(r.impressions) || 0;
      weightedPosition += (Number(r.position) || 0) * (Number(r.impressions) || 0);
   });
   return {
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 4) : 0,
      position: impressions > 0 ? round(weightedPosition / impressions, 1) : 0,
   };
};

/**
 * Build the bounded, summary-first insight response from the full InsightDataType.
 *
 * `limit` (already clamped by the route) overrides the default row caps for the keyword and page
 * lists (topKeywordsByClicks, untappedKeywords, topPages). Countries keep their fixed small cap and
 * the daily series is always returned in full (one compact row per day, ~30 rows max).
 */
export const summarizeInsight = (full: InsightDataType, limit?: number): InsightSummary => {
   const keywords = full.keywords || [];
   const pages = full.pages || [];
   const countries = full.countries || [];
   const statDays = full.stats || [];

   const topKeywordCap = limit ?? INSIGHT_DEFAULT_TOP_KEYWORDS;
   const untappedCap = limit ?? INSIGHT_DEFAULT_UNTAPPED_KEYWORDS;
   const topPageCap = limit ?? INSIGHT_DEFAULT_TOP_PAGES;

   // The helpers in utils/insight.ts already sort by clicks desc; re-sort defensively so the caps
   // always cut the LEAST valuable rows even if a caller hands unsorted data.
   const byClicks = [...keywords].sort((a, b) => b.clicks - a.clicks);
   const topKeywordsByClicks = byClicks.slice(0, topKeywordCap).map(keywordRow);

   // Untapped demand: low-click rows ranked by impressions. This is the view a marketer mines
   // (Google already shows you for these terms; the content just does not earn the click yet).
   const untappedKeywords = keywords
      .filter((k) => (Number(k.clicks) || 0) <= INSIGHT_LOW_CLICK_MAX)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, untappedCap)
      .map(keywordRow);

   const topPages = [...pages].sort((a, b) => b.clicks - a.clicks).slice(0, topPageCap).map(pageRow);
   const topCountries = [...countries].sort((a, b) => b.clicks - a.clicks).slice(0, INSIGHT_TOP_COUNTRIES).map(countryRow);

   // Compact daily series: date, clicks, impressions, position only (ctr is derivable).
   const days: InsightDayRow[] = statDays.map((d) => ({
      date: d.date,
      clicks: d.clicks,
      impressions: d.impressions,
      position: round(d.position, 1),
   }));

   // Aggregate stats: prefer the daily series (the authoritative site-wide totals); fall back to
   // aggregating the keyword rows when the stats fetch returned nothing.
   const agg = statDays.length > 0 ? aggregate(statDays) : aggregate(keywords);

   const truncated = keywords.length > topKeywordsByClicks.length
      || pages.length > topPages.length
      || countries.length > topCountries.length;

   const meta: InsightSummaryMeta = {
      totals: { keywords: keywords.length, pages: pages.length, countries: countries.length, days: days.length },
      truncated,
      hint: truncated
         ? `Lists are bounded: top ${topKeywordsByClicks.length} of ${keywords.length} keywords by clicks, `
            + `${untappedKeywords.length} untapped (low-click, high-impression) keywords, top ${topPages.length} of ${pages.length} pages, `
            + `top ${topCountries.length} of ${countries.length} countries. Pass limit=N (1..${INSIGHT_MAX_LIMIT}) to widen the keyword/page `
            + 'lists, or detail=true for the full unbounded arrays.'
         : 'Lists contain every keyword, page, and country for this property. Pass detail=true for the raw full-fidelity arrays.',
   };

   return {
      stats: { ...agg, window: `${days.length || 30}d` },
      topKeywordsByClicks,
      untappedKeywords,
      topPages,
      topCountries,
      days,
      meta,
   };
};
