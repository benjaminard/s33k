// Goal suggestion: turn a site crawl into ready-to-create conversion goals.
//
// Maximizing value with no UI means s33k should not make a user think up their conversions: it
// should propose them. Given the page summaries from a site crawl (utils/site-crawl.ts), this
// heuristically spots the two conversion shapes s33k can track from autocapture alone:
//   - destination/thank-you pages (a page_reached goal): the page a successful action lands on.
//   - intent/form pages (an event form_submit goal): the page where a form is filled.
// It RETURNS suggestions for the user's LLM to confirm; it never creates a goal on its own.

import type { PageSummary } from './site-crawl';

export type SuggestedGoal = {
   name: string,
   kind: 'page_reached' | 'event',
   matchValue: string,
   matchPage?: string,
   reason: string,
};

// Path/title signals that a page is a SUCCESS/destination page (the end of a conversion).
const DESTINATION_PATTERNS = [
   'thank-you', 'thank_you', 'thankyou', 'thanks', '/confirmation', '/confirmed', '/success',
   '/welcome', '/booked', '/scheduled', '/received', '/subscribed', '/complete',
];
const DESTINATION_WORDS = ['thank you', 'thanks for', 'confirmed', 'you are booked', 'scheduled', 'success', 'we received'];

// Path/title signals that a page is an INTENT page where a form is filled.
const INTENT_PATTERNS = [
   '/demo', '/contact', '/signup', '/sign-up', '/get-started', '/get-a-demo', '/request',
   '/trial', '/quote', '/subscribe', '/book', '/apply', '/register',
];

const titleCase = (s: string): string => s.replace(/[-_/]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/**
 * Propose conversion goals from crawled page summaries. Deduplicates by match target and caps the
 * list so a noisy site does not return dozens of weak suggestions.
 * @param {PageSummary[]} pages - Page summaries from a site crawl.
 * @returns {SuggestedGoal[]}
 */
export const suggestGoals = (pages: PageSummary[]): SuggestedGoal[] => {
   const out: SuggestedGoal[] = [];
   const seen = new Set<string>();
   const add = (g: SuggestedGoal, key: string) => {
      if (seen.has(key)) { return; }
      seen.add(key);
      out.push(g);
   };

   for (const p of pages) {
      const path = String(p.path || '').toLowerCase();
      const title = String(p.title || '').toLowerCase();

      // Destination / thank-you page -> page_reached goal (the strongest signal).
      const isDestination = DESTINATION_PATTERNS.some((d) => path.includes(d))
         || DESTINATION_WORDS.some((w) => title.includes(w));
      if (isDestination) {
         add({
            name: `${titleCase(p.path.replace(/.*\/(?=[^/]+$)/, '')) || 'Conversion'} reached`.replace(/\s+/g, ' '),
            kind: 'page_reached',
            matchValue: p.path,
            reason: `"${p.title || p.path}" looks like a success/thank-you page; reaching it signals a completed conversion.`,
         }, `page:${path}`);
         continue;
      }

      // Intent / form page -> event form_submit on that page. Match an exact path or a real path
      // segment only; a bare startsWith would over-match ('/demo' hitting '/democracy').
      const isIntent = INTENT_PATTERNS.some((d) => path === d || path.startsWith(`${d}/`));
      if (isIntent) {
         add({
            name: `${titleCase(p.path.replace(/^\//, '')) || 'Form'} submitted`,
            kind: 'event',
            matchValue: 'form_submit',
            matchPage: p.path,
            reason: `"${p.title || p.path}" looks like an intent page; a form submission on it signals a conversion.`,
         }, `form:${path}`);
      }
   }

   return out.slice(0, 10);
};
