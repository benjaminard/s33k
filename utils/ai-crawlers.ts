/**
 * AI crawler (answer-engine bot) classifier.
 *
 * The flagship 10x signal of s33k: which AI answer-engine bots are crawling the
 * site. AI crawlers visiting a page are the LEADING indicator of AEO. They show
 * up in server logs / request user-agents well before any AI engine starts
 * sending real visitors (which is what ai-sources.ts measures from referral
 * data). This module owns one job: given a raw user-agent string, decide whether
 * it is a known crawler, which bot and owner it is, and whether that bot is an
 * AI answer engine.
 *
 * It never queries an LLM and never throws. To add or adjust a crawler, edit the
 * CRAWLERS array below. Each entry maps one bot to:
 *   - the case-insensitive substrings that identify it in a user-agent,
 *   - a normalized owner label (OpenAI, Anthropic, Google, etc.),
 *   - whether it is an AI answer engine (true) versus a classic/search crawler
 *     that is not primarily an answer engine (false).
 *
 * Order matters only in that the first matching entry wins, so more-specific
 * patterns are kept ahead of broader ones (e.g. "OAI-SearchBot" and
 * "ChatGPT-User" ahead of nothing that would shadow them; "BingPreview" is a
 * distinct token from "Bingbot" so both are listed).
 */

/** One crawler bot and the user-agent substrings that identify it. */
export type CrawlerPattern = {
   /** The normalized, user-facing bot label, e.g. "GPTBot". */
   bot: string,
   /** The normalized owner label, e.g. "OpenAI". */
   owner: string,
   /** Whether this bot is an AI answer engine crawler. */
   isAiEngine: boolean,
   /** Case-insensitive substrings to match against the user-agent (lowercased). */
   match: string[],
}

/**
 * The editable crawler list. Add a row to detect a new bot; extend `match` to
 * catch a new token for an existing bot. Patterns are matched as case-insensitive
 * substrings against the lowercased user-agent.
 */
export const CRAWLERS: CrawlerPattern[] = [
   // OpenAI
   { bot: 'GPTBot', owner: 'OpenAI', isAiEngine: true, match: ['gptbot'] },
   { bot: 'OAI-SearchBot', owner: 'OpenAI', isAiEngine: true, match: ['oai-searchbot'] },
   { bot: 'ChatGPT-User', owner: 'OpenAI', isAiEngine: true, match: ['chatgpt-user'] },
   // Anthropic
   { bot: 'ClaudeBot', owner: 'Anthropic', isAiEngine: true, match: ['claudebot'] },
   { bot: 'Claude-Web', owner: 'Anthropic', isAiEngine: true, match: ['claude-web'] },
   { bot: 'Claude-User', owner: 'Anthropic', isAiEngine: true, match: ['claude-user'] },
   { bot: 'anthropic-ai', owner: 'Anthropic', isAiEngine: true, match: ['anthropic-ai'] },
   // Perplexity
   { bot: 'PerplexityBot', owner: 'Perplexity', isAiEngine: true, match: ['perplexitybot'] },
   { bot: 'Perplexity-User', owner: 'Perplexity', isAiEngine: true, match: ['perplexity-user'] },
   // Google (AI vs classic)
   { bot: 'Google-Extended', owner: 'Google', isAiEngine: true, match: ['google-extended'] },
   { bot: 'Googlebot', owner: 'Google', isAiEngine: false, match: ['googlebot'] },
   // Apple
   { bot: 'Applebot-Extended', owner: 'Apple', isAiEngine: true, match: ['applebot-extended'] },
   // Microsoft (Bing). BingPreview kept ahead of Bingbot so the more-specific token wins.
   { bot: 'BingPreview', owner: 'Microsoft', isAiEngine: true, match: ['bingpreview'] },
   { bot: 'Bingbot', owner: 'Microsoft', isAiEngine: false, match: ['bingbot'] },
   // Amazon
   { bot: 'Amazonbot', owner: 'Amazon', isAiEngine: true, match: ['amazonbot'] },
   // TikTok / ByteDance
   { bot: 'Bytespider', owner: 'ByteDance', isAiEngine: true, match: ['bytespider'] },
   // Common Crawl (training data feedstock for many AI engines)
   { bot: 'CCBot', owner: 'Common Crawl', isAiEngine: true, match: ['ccbot'] },
   // Meta AI
   { bot: 'Meta-ExternalAgent', owner: 'Meta', isAiEngine: true, match: ['meta-externalagent'] },
   { bot: 'FacebookBot', owner: 'Meta', isAiEngine: true, match: ['facebookbot'] },
   // DuckDuckGo AI assist
   { bot: 'DuckAssistBot', owner: 'DuckDuckGo', isAiEngine: true, match: ['duckassistbot'] },
   // Cohere
   { bot: 'cohere-ai', owner: 'Cohere', isAiEngine: true, match: ['cohere-ai'] },
   // You.com
   { bot: 'YouBot', owner: 'You.com', isAiEngine: true, match: ['youbot'] },
   // Diffbot
   { bot: 'Diffbot', owner: 'Diffbot', isAiEngine: true, match: ['diffbot'] },
   // ImagesiftBot
   { bot: 'ImagesiftBot', owner: 'Imagesift', isAiEngine: true, match: ['imagesiftbot'] },
];

/** The shape returned by classifyCrawler. */
export type CrawlerClassification = {
   isCrawler: boolean,
   bot: string | null,
   owner: string | null,
   isAiEngine: boolean,
}

/**
 * Classify a user-agent string as a known crawler or not.
 *
 * Never throws. Matches case-insensitively against CRAWLERS; the first bot with
 * any matching substring wins. Returns the bot, owner, and isAiEngine flag when a
 * crawler is recognized, or { isCrawler: false, bot: null, owner: null,
 * isAiEngine: false } otherwise (e.g. a normal browser user-agent).
 *
 * @param {string} userAgent - The raw User-Agent header value.
 * @returns {CrawlerClassification}
 */
export const classifyCrawler = (userAgent: string): CrawlerClassification => {
   const target = String(userAgent || '').toLowerCase();
   if (!target.trim()) {
      return { isCrawler: false, bot: null, owner: null, isAiEngine: false };
   }
   for (const entry of CRAWLERS) {
      if (entry.match.some((needle) => target.includes(needle))) {
         return { isCrawler: true, bot: entry.bot, owner: entry.owner, isAiEngine: entry.isAiEngine };
      }
   }
   return { isCrawler: false, bot: null, owner: null, isAiEngine: false };
};

export default classifyCrawler;
