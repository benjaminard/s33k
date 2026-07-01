/*
 * ============================================================================
 * s33k SUGGESTED QUESTIONS: the handholding centerpiece (RULES-BASED, no LLM).
 * ============================================================================
 * Ben's framing: "AI is the UI, but people need their hands held. The ultimate
 * handholding software where you can ask questions, but we also proactively show
 * people what they need to know." Marketers often do NOT know what to ask. This
 * catalog is the answer: a curated set of natural-language questions, each mapped
 * to the real MCP tool that answers it, with a one-line "why" so the user
 * understands the value before they ask.
 *
 * selectSuggestedQuestions takes the compact DashboardState and returns a
 * CONTEXTUAL, prioritized subset: if there are unranked keywords it surfaces
 * focus/striking questions; if AI referrals exist it surfaces AEO questions; if
 * goals exist it surfaces conversion questions; if web-vital samples exist it
 * surfaces speed questions. STARTER_QUESTIONS is the fixed "first run" set for a
 * brand-new domain with no data yet.
 *
 * Every `tool` here is a REAL registered MCP tool name (mcp/src/index.ts). The
 * coverage relationship is one-way and loose: a question points at a tool, not
 * the reverse, so adding a question never requires a new tool.
 * ============================================================================
 */

import type { DashboardState } from './dashboard';

/** One handholding question: what to ask, which tool answers it, and why it matters. */
export type SuggestedQuestion = {
   /** The natural-language question, phrased exactly as a marketer would say it. */
   question: string,
   /** The real registered MCP tool the connected LLM should call to answer it. */
   tool: string,
   /** Which pillar the question belongs to (for grouping in the UI/renderer). */
   pillar: 'seo' | 'aeo' | 'analytics' | 'cross-pillar',
   /** One line on why this question is worth asking (the value, not a restatement). */
   why: string,
};

/**
 * The full curated catalog (~16). Every entry is a real question a marketer asks,
 * mapped to a real tool. selectSuggestedQuestions filters/prioritizes from here;
 * nothing reads the whole catalog directly except the "list everything" path.
 */
export const QUESTION_CATALOG: SuggestedQuestion[] = [
   // --- Cross-pillar (the "tell me what to do" questions). ------------------
   {
      question: 'What should I do next?',
      tool: 'insights',
      pillar: 'cross-pillar',
      why: 'Turns all three pillars into a short, prioritized to-do list instead of a wall of numbers.',
   },
   {
      question: 'What changed this week?',
      tool: 'weekly_digest',
      pillar: 'cross-pillar',
      why: 'Compares this period to last so you see movement, not just a static snapshot.',
   },
   {
      question: 'Give me the executive summary',
      tool: 'executive_summary',
      pillar: 'cross-pillar',
      why: 'One paste-ready paragraph of the whole picture, good for a status update to a boss or client.',
   },
   {
      question: 'How is my site doing right now?',
      tool: 'briefing',
      pillar: 'cross-pillar',
      why: 'A daily standup across SEO, AI search, and traffic, with the top 3 actions for today.',
   },
   {
      question: 'What changed and what should I do about it?',
      tool: 'alerts',
      pillar: 'cross-pillar',
      why: 'Surfaces the notable shifts (rank moves, traffic swings, new AI engines) with a fix for each.',
   },
   // --- SEO. ----------------------------------------------------------------
   {
      question: 'Which pages should I add keywords to?',
      tool: 'insights',
      pillar: 'seo',
      why: 'Finds pages that already earn traffic but have no tracked keyword, the cheapest SEO leverage.',
   },
   {
      question: 'What are my quick-win keywords?',
      tool: 'striking_distance',
      pillar: 'seo',
      why: 'Lists keywords sitting just off page one (positions 11-20), where a small push pays off fastest.',
   },
   {
      question: 'Who is outranking me in search?',
      tool: 'competitor_visibility',
      pillar: 'seo',
      why: 'Shows which competitors hold the positions above you for your tracked keywords.',
   },
   {
      question: 'How is my keyword ranking overall?',
      tool: 'seo_report',
      pillar: 'seo',
      why: 'The full rank picture: how many keywords sit in the top 3, top 10, page one, and off the map.',
   },
   {
      question: 'What pages am I missing keywords for?',
      tool: 'content_gap',
      pillar: 'seo',
      why: 'Spots topics and pages your competitors rank for that you have no coverage on.',
   },
   // --- AEO / AI search. ----------------------------------------------------
   {
      question: 'Are AI engines sending me traffic?',
      tool: 'ai_referrals',
      pillar: 'aeo',
      why: 'Shows real visitors arriving from ChatGPT, Claude, Gemini, and Perplexity, the proof AEO is paying off.',
   },
   {
      question: 'Am I visible in AI search, and where are the gaps?',
      tool: 'ai_visibility',
      pillar: 'aeo',
      why: 'Per-page and per-engine view of which AI engines cite you, plus an AI-readiness audit when referrals are thin.',
   },
   // --- Analytics. ----------------------------------------------------------
   {
      question: 'What is my real human traffic vs bots?',
      tool: 'human_analytics',
      pillar: 'analytics',
      why: 'Filters out datacenter and bot hits so you plan against the honest human number, not an inflated one.',
   },
   {
      question: 'Where do my visitors land first?',
      tool: 'entry_page_report',
      pillar: 'analytics',
      why: 'Your acquisition surface: which pages start sessions, and how people got there (direct, search, AI).',
   },
   {
      question: 'How fast is my site for real users?',
      tool: 'web_vitals',
      pillar: 'analytics',
      why: 'Real-user Core Web Vitals (LCP, CLS, INP), the speed scores Google actually ranks you on.',
   },
   {
      question: 'Which campaign converts best?',
      tool: 'campaign_report',
      pillar: 'analytics',
      why: 'Ties your UTM campaigns to sessions and conversions so you know which spend is working.',
   },
   {
      question: 'Which traffic source drives my conversions?',
      tool: 'conversion_attribution',
      pillar: 'analytics',
      why: 'Attributes conversions to their first-touch source (direct, search, referral, AI), no GA4 setup needed.',
   },
   {
      question: 'How are all my sites doing?',
      tool: 'portfolio_summary',
      pillar: 'cross-pillar',
      why: 'One scoreboard across every domain you track, so you can spot which site needs attention first.',
   },
];

/**
 * The fixed "starter 5" for the very first run, when a domain has almost no data.
 * These onboard the marketer toward value: add keywords, find pages, install
 * tracking, and learn what to ask. Order is the order to show them in.
 */
export const STARTER_QUESTIONS: SuggestedQuestion[] = [
   {
      question: 'How is my site doing right now?',
      tool: 'briefing',
      pillar: 'cross-pillar',
      why: 'The fastest way to see everything s33k knows about your site in one answer.',
   },
   {
      question: 'What pages should I be tracking keywords for?',
      tool: 'discover_pages',
      pillar: 'seo',
      why: 'Crawls your site and proposes target keywords per page so you do not start from a blank slate.',
   },
   {
      question: 'How do I install the tracking code?',
      tool: 'install_instructions',
      pillar: 'analytics',
      why: 'A copy-paste snippet that turns on traffic, sources, conversions, and speed tracking in minutes.',
   },
   {
      question: 'Are AI engines sending me traffic?',
      tool: 'ai_referrals',
      pillar: 'aeo',
      why: 'Starts the AEO loop: see whether ChatGPT, Claude, Gemini, or Perplexity already refer visitors.',
   },
   {
      question: 'What can s33k do?',
      tool: 'help',
      pillar: 'cross-pillar',
      why: 'A guided tour of every question you can ask, so you always know what is possible next.',
   },
];

/**
 * Select a contextual, prioritized subset of questions for the current data.
 *
 * Pure. Reads the compact DashboardState (derived from the composed dashboard)
 * and returns the questions most worth asking right now, highest priority first,
 * de-duplicated. For a genuinely empty domain it returns the STARTER set so the
 * very first run still holds the user's hand. The result is capped so the
 * "TRY ASKING" list stays a glance, never a backlog.
 *
 * @param {DashboardState} state - The compact data-availability state.
 * @param {number} [limit] - Max questions to return (default 6).
 * @returns {SuggestedQuestion[]}
 */
export const selectSuggestedQuestions = (state: DashboardState, limit = 6): SuggestedQuestion[] => {
   // A brand-new domain with no data: hand-hold with the starter set verbatim.
   if (state.isEmpty) {
      return STARTER_QUESTIONS.slice(0, limit);
   }

   const byTool = new Map(QUESTION_CATALOG.map((q) => [`${q.tool}:${q.question}`, q]));
   const pick = (tool: string, question: string): SuggestedQuestion | undefined => byTool.get(`${tool}:${question}`);

   // Build a priority-ordered list of keys to consider. Earlier = higher priority.
   // Each block is gated on the signal that makes its question relevant, so the
   // questions on screen always match what the data actually shows.
   const ordered: Array<SuggestedQuestion | undefined> = [];

   // 1. The single most useful next step is always "what should I do next".
   ordered.push(pick('insights', 'What should I do next?'));

   // 2. SEO gaps: unranked keywords or no keywords at all -> focus questions.
   if (state.hasUnrankedKeywords || !state.hasKeywords) {
      ordered.push(pick('insights', 'Which pages should I add keywords to?'));
   }
   // 3. Striking-distance quick wins, when some keywords rank but not all on page one.
   if (state.hasStrikingDistance) {
      ordered.push(pick('striking_distance', 'What are my quick-win keywords?'));
   }
   // 4. AEO: if AI engines already refer traffic, surface the AEO questions.
   if (state.hasAiReferrals) {
      ordered.push(pick('ai_referrals', 'Are AI engines sending me traffic?'));
      ordered.push(pick('ai_visibility', 'Am I visible in AI search, and where are the gaps?'));
   }
   // 5. Conversions, only when goals are defined.
   if (state.hasGoals) {
      ordered.push(pick('conversion_attribution', 'Which traffic source drives my conversions?'));
      ordered.push(pick('campaign_report', 'Which campaign converts best?'));
   }
   // 6. Speed, only when there are real-user web-vital samples.
   if (state.hasWebVitals) {
      ordered.push(pick('web_vitals', 'How fast is my site for real users?'));
   }
   // 7. Traffic-quality + acquisition questions, when there is traffic to analyze.
   if (state.hasTraffic) {
      ordered.push(pick('human_analytics', 'What is my real human traffic vs bots?'));
      if (state.hasEntries) {
         ordered.push(pick('entry_page_report', 'Where do my visitors land first?'));
      }
   }
   // 8. Competitive view, when keywords are tracked.
   if (state.hasKeywords) {
      ordered.push(pick('competitor_visibility', 'Who is outranking me in search?'));
   }

   // Always-useful cross-pillar fallbacks at the tail, so the list is never short
   // even on a thin-but-not-empty domain.
   ordered.push(pick('weekly_digest', 'What changed this week?'));
   ordered.push(pick('executive_summary', 'Give me the executive summary'));
   ordered.push(pick('briefing', 'How is my site doing right now?'));

   // De-dupe (by question text) preserving order, drop any undefined, then cap.
   const seen = new Set<string>();
   const out: SuggestedQuestion[] = [];
   for (const q of ordered) {
      if (q && !seen.has(q.question)) {
         seen.add(q.question);
         out.push(q);
         if (out.length >= limit) { break; }
      }
   }
   return out;
};
