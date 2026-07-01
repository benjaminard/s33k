/**
 * AI-referrer classifier.
 *
 * Phase 4 of s33k reframes "AEO" as AI REFERRAL TRACKING: which AI engines
 * (ChatGPT, Perplexity, Gemini, Claude, Copilot, etc.) are actually sending
 * real visitors to the site. That signal comes from analytics REFERRAL data,
 * never from querying an LLM.
 *
 * This module owns the one job of deciding, for a given referral source string
 * (a hostname, a full URL, or a supplied label like "ChatGPT"), whether it is an
 * AI engine and, if so, which one. The first-party provider reports raw referrer
 * hosts and does NOT pre-tag AI, so it relies entirely on this classifier; the
 * classifier also normalizes any already-labeled engine to a consistent label.
 *
 * To add or adjust an engine, edit the AI_ENGINES array below. Each entry maps
 * one normalized engine label to the list of case-insensitive substrings that
 * identify it in a host or name. Order matters only in that the first matching
 * engine wins, so keep more-specific patterns ahead of broader ones.
 */

/** One AI engine and the host/name substrings that identify it (case-insensitive). */
export type AiEnginePattern = {
   /** The normalized, user-facing engine label, e.g. "ChatGPT". */
   engine: string,
   /** Substrings to match against the referrer host or name (lowercased). */
   match: string[],
}

/**
 * The editable AI-engine list. Add a row to track a new engine; extend `match`
 * to catch a new host or label for an existing engine. Patterns are matched as
 * case-insensitive substrings against the cleaned source string.
 */
export const AI_ENGINES: AiEnginePattern[] = [
   { engine: 'ChatGPT', match: ['chatgpt', 'chat.openai.com', 'openai.com', 'oai.azure'] },
   { engine: 'Perplexity', match: ['perplexity'] },
   { engine: 'Gemini', match: ['gemini.google.com', 'gemini', 'bard.google.com', 'bard'] },
   { engine: 'Google AI Overviews', match: ['google ai overview', 'ai.google', 'aioverview'] },
   { engine: 'Claude', match: ['claude.ai', 'claude', 'anthropic'] },
   { engine: 'Copilot', match: ['copilot.microsoft.com', 'copilot', 'bingchat', 'bing.com/chat'] },
   { engine: 'You.com', match: ['you.com'] },
   { engine: 'Poe', match: ['poe.com', 'poe'] },
   { engine: 'Phind', match: ['phind'] },
   { engine: 'Meta AI', match: ['meta.ai'] },
   { engine: 'DeepSeek', match: ['deepseek'] },
   { engine: 'Grok', match: ['grok', 'x.ai'] },
];

/**
 * Reduce a referral source (host, full URL, or label) to a lowercase string
 * suitable for substring matching. If a full URL is passed, the host plus path
 * is kept so host-specific and path-specific patterns (e.g. "bing.com/chat")
 * both have a chance to match.
 * @param {string} source - Raw referral source.
 * @returns {string} A lowercased, trimmed match target.
 */
const normalizeSource = (source: string): string => {
   const raw = String(source || '').trim().toLowerCase();
   if (!raw) { return ''; }
   try {
      if (/^https?:\/\//i.test(raw)) {
         const u = new URL(raw);
         return `${u.host}${u.pathname}`.toLowerCase();
      }
   } catch {
      // Not a parseable URL; fall through and match the raw string.
   }
   return raw;
};

/**
 * Classify a referral source as an AI engine or not.
 *
 * Never throws. Matches case-insensitively against AI_ENGINES; the first engine
 * with any matching substring wins. Returns the normalized engine label when AI,
 * or { isAI: false, engine: null } otherwise.
 *
 * @param {string} source - A referrer hostname, full URL, or provider label
 *                          (e.g. "chatgpt.com", "https://www.perplexity.ai/", "Claude").
 * @returns {{ isAI: boolean, engine: string | null }}
 */
export const classifyReferrer = (source: string): { isAI: boolean, engine: string | null } => {
   const target = normalizeSource(source);
   if (!target) { return { isAI: false, engine: null }; }
   for (const entry of AI_ENGINES) {
      if (entry.match.some((needle) => target.includes(needle))) {
         return { isAI: true, engine: entry.engine };
      }
   }
   return { isAI: false, engine: null };
};

/** The four first-touch source classes a referral string is bucketed into. */
export type SourceClass = 'direct' | 'referral' | 'search' | 'ai';

/**
 * Host substrings that identify a TRADITIONAL search engine (not an AI engine,
 * which is handled by AI_ENGINES). Order does not matter; any match wins. Keep
 * this conservative: an unknown external referrer should fall through to
 * "referral", not be guessed as search.
 */
const SEARCH_ENGINES: string[] = [
   'google.', 'bing.', 'duckduckgo', 'yahoo.', 'yandex.', 'baidu.',
   'ecosia.', 'brave.com/search', 'search.brave', 'startpage', 'qwant',
   'ask.com', 'aol.', 'naver.', 'seznam.',
];

/**
 * Classify a single referral source string into one of four first-touch classes
 * (direct / referral / search / ai), reusing the AI classifier for the AI case.
 *
 * Rules, in order:
 *   1. Empty/blank/"(none)"/"direct" -> direct (no-referrer entries are reported
 *      this way). When selfHost is provided, a referrer on that same host is also
 *      treated as direct (an internal self-referral, not a real external source).
 *   2. An AI engine (classifyReferrer) -> ai.
 *   3. A known search-engine host -> search.
 *   4. Anything else external -> referral.
 *
 * Never throws.
 * @param {string} source - The referrer host, full URL, or provider label.
 * @param {string} [selfHost] - The site's own host, so self-referrals count as direct.
 * @returns {SourceClass}
 */
export const classifySourceClass = (source: string, selfHost?: string): SourceClass => {
   const raw = String(source || '').trim().toLowerCase();
   if (!raw || raw === '(none)' || raw === 'direct' || raw === '(direct)' || raw === 'none') {
      return 'direct';
   }
   const target = normalizeSource(raw);
   const self = String(selfHost || '').trim().toLowerCase().replace(/^www\./, '');
   if (self && (target === self || target.startsWith(`${self}/`) || target.includes(`//${self}`))) {
      return 'direct';
   }
   if (classifyReferrer(raw).isAI) { return 'ai'; }
   if (SEARCH_ENGINES.some((needle) => target.includes(needle))) { return 'search'; }
   return 'referral';
};

export default classifyReferrer;
