import { setTimeout as sleep } from 'timers/promises';
import { RefreshResult, removeFromRetryQueue, retryScrape, scrapeKeywordWithStrategy } from './scraper';
import parseKeywords from './parseKeywords';
import Keyword from '../database/models/keyword';
import { runWithConcurrency, scrapeConcurrency } from './scrape-queue';

/**
 * Refreshes the Keywords position by Scraping Google Search Result by
 * Determining whether the keywords should be scraped in Parallel or not
 * @param {Keyword[]} rawKeyword - Keywords to scrape
 * @param {SettingsType} settings - The App Settings that contain the Scraper settings
 * @param {DomainType[]} domains - Optional domain list for per-domain strategy overrides
 * @returns {Promise}
 */
const refreshAndUpdateKeywords = async (rawKeyword:Keyword[], settings:SettingsType, domains?: DomainType[]): Promise<KeywordType[]> => {
   const keywords:KeywordType[] = rawKeyword.map((el) => el.get({ plain: true }));
   if (!rawKeyword || rawKeyword.length === 0) { return []; }
   const updatedKeywords: KeywordType[] = [];

   if (['scrapingant', 'serpapi', 'searchapi'].includes(settings.scraper_type)) {
      const refreshedResults = await refreshParallel(keywords, settings, domains);
      if (refreshedResults.length > 0) {
         for (const keyword of rawKeyword) {
            const refreshedKeywordData = refreshedResults.find((k) => k && k.ID === keyword.ID);
            if (refreshedKeywordData) {
               const updatedKeyword = await updateKeywordPosition(keyword, refreshedKeywordData, settings);
               updatedKeywords.push(updatedKeyword);
            }
         }
      }
   } else {
      for (const keyword of rawKeyword) {
         const keywordPlain = keyword.get({ plain: true }) as KeywordType;
         const domainSettings = domains?.find((d) => d.domain === keywordPlain.domain);
         const updatedKeyword = await refreshAndUpdateKeyword(keyword, settings, domainSettings);
         updatedKeywords.push(updatedKeyword);
         if (keywords.length > 0 && settings.scrape_delay && settings.scrape_delay !== '0') {
            await sleep(parseInt(settings.scrape_delay, 10));
         }
      }
   }

   return updatedKeywords;
};

/**
 * Scrape Serp for given keyword and update the position in DB.
 * @param {Keyword} keyword - Keywords to scrape
 * @param {SettingsType} settings - The App Settings that contain the Scraper settings
 * @param {DomainType} domainSettings - Optional domain-level settings override
 * @returns {Promise<KeywordType>}
 */
const refreshAndUpdateKeyword = async (keyword: Keyword, settings: SettingsType, domainSettings?: DomainType): Promise<KeywordType> => {
   const currentKeyword = keyword.get({ plain: true });
   const refreshedKeywordData = await scrapeKeywordWithStrategy(currentKeyword, settings, domainSettings);
   const updatedKeyword = refreshedKeywordData ? await updateKeywordPosition(keyword, refreshedKeywordData, settings) : currentKeyword;
   return updatedKeyword;
};

/**
 * Processes the scraped data for the given keyword and updates the keyword serp position in DB.
 * @param {Keyword} keywordRaw - Keywords to Update
 * @param {RefreshResult} updatedKeyword - scraped Data for that Keyword
 * @param {SettingsType} settings - The App Settings that contain the Scraper settings
 * @returns {Promise<KeywordType>}
 */
export const updateKeywordPosition = async (keywordRaw:Keyword, updatedKeyword: RefreshResult, settings: SettingsType): Promise<KeywordType> => {
   const keywordParsed = parseKeywords([keywordRaw.get({ plain: true })]);
      const keyword = keywordParsed[0];
      // const updatedKeyword = refreshed;
      let updated = keyword;

      if (updatedKeyword && keyword) {
         const newPos = updatedKeyword.position;
         const { history } = keyword;
         const theDate = new Date();
         // ISO date key (UTC, zero-padded): "2026-06-09", not the old locale-ambiguous "2026-6-9".
         // The old non-padded form parsed as LOCAL midnight in new Date(key) while the rank-movers
         // window bounds are UTC, skewing "what moved". ISO parses as UTC midnight and sorts lexically.
         // Old keys are still read back: every parser of these keys normalizes both formats (see
         // utils/history-date.ts normalizeHistoryDateKey), so existing history stays correct.
         const dateKey = theDate.toISOString().slice(0, 10);
         history[dateKey] = newPos;

         const updatedVal = {
            position: newPos,
            updating: false,
            url: updatedKeyword.url,
            lastResult: updatedKeyword.result,
            history,
            lastUpdated: updatedKeyword.error ? keyword.lastUpdated : theDate.toJSON(),
            lastUpdateError: updatedKeyword.error
               ? JSON.stringify({ date: theDate.toJSON(), error: `${updatedKeyword.error}`, scraper: settings.scraper_type })
               : 'false',
         };

         // If failed, Add to Retry Queue Cron
         if (updatedKeyword.error && settings?.scrape_retry) {
            await retryScrape(keyword.ID);
         } else {
            await removeFromRetryQueue(keyword.ID);
         }

         // Update the Keyword Position in Database
         try {
            await keywordRaw.update({
               ...updatedVal,
               lastResult: Array.isArray(updatedKeyword.result) ? JSON.stringify(updatedKeyword.result) : updatedKeyword.result,
               history: JSON.stringify(history),
            });
            updated = { ...keyword, ...updatedVal, lastUpdateError: JSON.parse(updatedVal.lastUpdateError) };
         } catch (error) {
            console.error('[ERROR] Updating SERP for Keyword', keyword.keyword, error);
         }
      }

      return updated;
};

/**
 * Scrape Google Keyword Search Result in Parallel.
 * @param {KeywordType[]} keywords - Keywords to scrape
 * @param {SettingsType} settings - The App Settings that contain the Scraper settings
 * @param {DomainType[]} domains - Optional domain list for per-domain strategy overrides
 * @returns {Promise}
 */
const refreshParallel = async (keywords:KeywordType[], settings:SettingsType, domains?: DomainType[]) : Promise<RefreshResult[]> => {
   // Schedule the per-keyword scrapes through a BOUNDED-concurrency runner (SCRAPE_CONCURRENCY,
   // default 10) instead of firing every scrape at once with Promise.allSettled. The old form
   // launched one HTTP promise per keyword simultaneously, so a full sweep (1000 sites x 50 kw)
   // meant 50,000 concurrent SERP calls in one request: OOM, socket exhaustion, a Serper spend
   // spike, and a timeout that lost all progress. runWithConcurrency does the SAME total work,
   // returns the SAME per-item settlements in input order, and rejects nothing (a throwing scrape
   // becomes a 'rejected' settlement), so the aggregation/return shape below is byte-for-byte the
   // same as the previous Promise.allSettled: keep only the fulfilled values, in order.
   const results = await runWithConcurrency<KeywordType, RefreshResult>(
      keywords,
      (keyword) => {
         const domainSettings = domains?.find((d) => d.domain === keyword.domain);
         return scrapeKeywordWithStrategy(keyword, settings, domainSettings);
      },
      scrapeConcurrency(),
   );
   const fulfilled = results.filter((r): r is PromiseFulfilledResult<RefreshResult> => r.status === 'fulfilled');

   return fulfilled.map((r) => r.value);
};

export default refreshAndUpdateKeywords;
