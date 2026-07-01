// Exact per-landing-page AI-search counts from first-party sessions.
//
// The cross-pillar moat (entry_pages, page_scoreboard) asks "which pages did AI search land on".
// Umami does not expose a per-landing-page referral path, so the old approach approximated AI by
// page from the site-wide referrer mix (and reported 0 with an apology note). But s33k already owns
// the exact answer in its own first-party event stream: sessionize the s33k_event rows, take the
// sessions whose first-touch channel classified to 'ai', and group them by their landing page. That
// is an EXACT count of AI-search-first sessions per entry page, computed from data we own, no
// provider landing_path needed.
//
// This module is the shared, pure helper both routes call so the exact AI-by-landing computation
// can never diverge between them. No server-side LLM: it is a rules-based group-by over owned rows.

import { sessionize, EventLike } from './sessionize';
import { cleanPath } from './clean-path';

/**
 * Group HUMAN first-party AI-channel sessions by their landing page, keyed by clean path, returning
 * EXACT unique-session (visitor) counts per page. The caller scopes the rows (domain + window +
 * tenant) before passing them in, so this never reads anything outside the caller's scope.
 *
 * Bots are EXCLUDED (is_bot sessions dropped): "which pages did AI search land HUMANS on" is the
 * honest question, matching the human-only default of the entry-page acquisition lens. Only sessions
 * with at least one pageview credit a landing page (the pageviewCount > 0 guard), matching the
 * entry-page report: a pageview-less session cannot credit a page that was never viewed. The returned
 * map keys use cleanPath() so they line up with the pathClean keys both routes match keywords/traffic on.
 * @param {EventLike[]} rows - Scoped s33k_event rows (domain + period + tenant already applied).
 * @returns {{ byLanding: Map<string, number>, totalAiSessions: number }} byLanding: exact human AI
 *   sessions per clean landing path; totalAiSessions: total human AI-channel sessions with a pageview
 *   (0 = no first-party AI data, so the caller may fall back to the approximated path).
 */
export const aiLandingFromSessions = (rows: EventLike[]): { byLanding: Map<string, number>, totalAiSessions: number } => {
   const byLanding = new Map<string, number>();
   let totalAiSessions = 0;
   // sessionize normalizes each session's first-touch source to one of four channels; 'ai' is the
   // AI-search class. It also resolves landingPage to the session's first pageview and flags bots.
   sessionize(rows)
      .filter((s) => s.channel === 'ai' && !s.isBot && s.pageviewCount > 0)
      .forEach((s) => {
         totalAiSessions += 1;
         const key = cleanPath(s.landingPage);
         byLanding.set(key, (byLanding.get(key) || 0) + 1);
      });
   return { byLanding, totalAiSessions };
};
