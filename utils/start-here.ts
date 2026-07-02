/*
 * ============================================================================
 * s33k START HERE: the explicit guided entry point for "I do not know what to ask".
 * ============================================================================
 * A co-founder's V1 review said s33k had "no easy mode": a user connects their
 * LLM and is staring at 80+ tools with no obvious first move. start_here is that
 * first move. Give it a domain (or no domain to pick one) and it returns, in
 * priority order: which domain, your setup state, the single most important thing
 * to do now, and a SHORT curated list of where to look next. It deliberately
 * surfaces entry_pages ("which pages did AI search land on"), which the same
 * reviewer could not find on their own.
 *
 * This file is the PURE shaping layer. It does NO IO: no DB, no network, no auth,
 * no LLM. The route (pages/api/start-here.ts) does the tenant-scoped reads (it
 * reuses the dashboard composer and the onboarding step counts) and hands the
 * already-shaped numbers here. Keeping the shaping pure makes every mode
 * (pick-domain, setup, ready) unit-testable without booting anything, the same
 * way buildDashboard and the analyst engine stay pure.
 * ============================================================================
 */

// --- Setup checklist (the same five steps onboarding-status reports). --------
//
// The route loads the four raw counts (owned, keywords, recent events, goals)
// and hands them here; this pure function turns them into the checklist +
// percentComplete + the single next step, EXACTLY mirroring the steps in
// pages/api/onboarding-status.ts so the two never disagree. start_here only
// needs the next step and the percentage, not the full step array on the wire,
// so it returns a compact result.

/** The raw, already-scoped setup signals the route reads for a domain. */
export type SetupSignals = {
   owned: boolean,
   keywordCount: number,
   recentEvents: number,
   goalCount: number,
   // MODULAR PILLARS: false when no SERP scraper key is configured, which means the SEO module is
   // simply OFF (an optional module, not missing setup). The track_keywords step is then omitted
   // from the checklist and first_report no longer requires keywords, so a keyless instance with
   // flowing analytics reads as HEALTHY/complete. Optional and additive: callers that do not pass
   // it keep the prior five-step behavior byte-for-byte (SEO assumed enabled).
   seoEnabled?: boolean,
   // The domain, used only to phrase the "add your site" step. Optional: start_here always has one
   // by the time it computes setup, and setup_status passes its domain so the wording is unchanged.
   domain?: string,
   // True when keywords are tracked but EVERY one is still rank-pending (first Google check running).
   // Optional and additive: callers that do not pass it keep the prior "N keyword(s) tracked." wording,
   // so done/percentComplete and the existing parity tests are unchanged. Only the track_keywords
   // step DETAIL changes, to "queued, first check running" instead of implying done-with-no-results.
   keywordsRankPending?: boolean,
};

/** One checklist step: matches onboarding-status's Step shape. */
export type SetupStep = { key: string, title: string, done: boolean, detail: string, nextTool: string };

/** The setup state. `steps` is the full checklist; the rest is what start_here acts on. */
export type SetupState = {
   steps: SetupStep[],
   percentComplete: number,
   complete: boolean,
   nextStep: SetupStep | null,
};

/**
 * Compute the setup checklist + percentComplete + next step from the raw counts.
 * Pure, and the SINGLE source of the five setup steps: pages/api/onboarding-status.ts (setup_status)
 * imports this too, so start_here and setup_status can never disagree about setup state.
 *
 * @param {SetupSignals} s - The scoped setup counts for one domain.
 * @returns {SetupState}
 */
export const computeSetupState = (s: SetupSignals): SetupState => {
   const site = s.domain || 'your site';
   // The SEO module defaults to enabled (legacy callers pass no flag). When it is OFF, tracking
   // keywords is not a setup step (there is no scraper to check them), so the step is omitted and
   // first_report stops requiring keywords: analytics-first is a designed-for path, not a degraded
   // one, and a keyless instance must be able to reach 100% / complete.
   const seoEnabled = s.seoEnabled !== false;
   const steps: SetupStep[] = [
      {
         key: 'add_domain',
         title: 'Add your site',
         done: s.owned,
         detail: s.owned ? `${site} is being tracked.` : `Add ${site} so s33k can track it.`,
         nextTool: 'onboard (or create_domain)',
      },
      ...(seoEnabled ? [{
         key: 'track_keywords',
         title: 'Track keywords',
         done: s.keywordCount > 0,
         // When keywords exist but all are rank-pending, say the first check is running rather than
         // implying the tracking is done with no positions to show. Done state is unchanged (tracking
         // IS set up); only the wording reflects that the first Google check has not landed yet.
         detail: (() => {
            if (s.keywordCount <= 0) {
               return 'Track the terms you want to rank for so s33k can watch your Google position.';
            }
            if (s.keywordsRankPending) {
               return `${s.keywordCount} keyword(s) queued, first Google rank check running.`;
            }
            return `${s.keywordCount} keyword(s) tracked.`;
         })(),
         nextTool: 'add_keyword (or onboard auto-discovers up to 20)',
      }] : []),
      {
         key: 'install_tracking',
         title: 'Install the tracking script',
         done: s.recentEvents > 0,
         detail: s.recentEvents > 0 ? 'The s33k.js script is live and sending data.'
            : 'Add the one-line s33k.js script to your site so traffic, human-vs-bot, and conversions can flow in.',
         nextTool: 'install_instructions',
      },
      {
         key: 'define_goals',
         title: 'Define your conversions',
         done: s.goalCount > 0,
         detail: s.goalCount > 0 ? `${s.goalCount} conversion goal(s) defined.`
            : 'Define what counts as a conversion (a thank-you page, a form submit) so s33k can report conversion rates.',
         nextTool: 'suggest_goals (auto-propose), then create_goal',
      },
      {
         key: 'first_report',
         title: 'See your first report',
         done: s.owned && (!seoEnabled || s.keywordCount > 0) && s.recentEvents > 0,
         detail: 'Get the proactive cross-pillar standup: what is happening and what to do next.',
         nextTool: 'briefing (and conversion_attribution once conversions accrue)',
      },
   ];
   const doneCount = steps.filter((step) => step.done).length;
   const percentComplete = Math.round((100 * doneCount) / steps.length);
   const nextStep = steps.find((step) => !step.done) || null;
   return { steps, percentComplete, complete: nextStep === null, nextStep };
};

// --- MODULES: the instance's pillar surfaces, described as optional modules. --
//
// The headless direction reframes the three pillars as MODULES of one instance: Analytics and AI
// referrals are always-on (they only wait for the beacon), SEO is optional and gated on a SERP
// scraper key. The point of the framing: a keyless instance with flowing analytics is a HEALTHY
// instance with one optional module off, never an incomplete setup. setup_status and start_here
// both surface this block so an LLM can say "everything you enabled is live" instead of "setup is
// missing something".

/** One module's status line. `enable` is only present when the module is off and enable-able. */
export type ModuleStatus = {
   key: 'analytics' | 'ai_referrals' | 'seo',
   name: string,
   status: 'live' | 'waiting_for_beacon' | 'enabled' | 'not_enabled',
   detail: string,
   enable?: string,
};

/** The signals computeModules needs, already scoped/loaded by the route. */
export type ModuleSignals = {
   recentEvents: number,
   seoEnabled: boolean,
   keywordCount: number,
};

/**
 * Describe the instance as modules. Pure. Analytics is live once beacon events flow; AI referrals
 * ride analytics (same beacon, referrer-classified); SEO is enabled iff a scraper key is
 * configured, otherwise "not enabled" WITH the conversational enablement path: the user asks
 * their LLM to enable SEO, the LLM calls mint_key_drop, and the key never touches the chat.
 * @param {ModuleSignals} m - The scoped module signals.
 * @returns {ModuleStatus[]}
 */
export const computeModules = (m: ModuleSignals): ModuleStatus[] => [
   {
      key: 'analytics',
      name: 'Analytics',
      status: m.recentEvents > 0 ? 'live' : 'waiting_for_beacon',
      detail: m.recentEvents > 0
         ? 'Live: the s33k.js beacon is sending events (traffic, sources, human-vs-bot, conversions).'
         : 'Waiting for the beacon: add the one-line s33k.js script to your site (install_instructions).',
   },
   {
      key: 'ai_referrals',
      name: 'AI referrals (AEO)',
      status: m.recentEvents > 0 ? 'live' : 'waiting_for_beacon',
      detail: m.recentEvents > 0
         ? 'Live with analytics: visits referred by ChatGPT, Claude, Gemini, and Perplexity are classified automatically.'
         : 'Comes alive with analytics: the same beacon classifies AI-engine referrals, no extra setup.',
   },
   {
      key: 'seo',
      name: 'SEO (Google rank tracking)',
      status: m.seoEnabled ? 'enabled' : 'not_enabled',
      detail: m.seoEnabled
         ? `Enabled: a SERP scraper key is configured${m.keywordCount > 0 ? ` and ${m.keywordCount} keyword(s) are tracked` : ''}.`
         : 'Not enabled (optional): no SERP scraper key is configured. Analytics and AI referrals work without it.',
      ...(m.seoEnabled ? {} : {
         enable: 'Ask me to enable SEO and I will mint a key-drop command (mint_key_drop): you run one curl line in '
            + 'your own terminal and paste your Serper key there, so the key never passes through this chat.',
      }),
   },
];

// --- The curated "where to look next" pointers. ------------------------------
//
// This is the #3 surfacing the brief demands: the reviewer could not find the
// already-built "which pages did AI search land on" view, so start_here ALWAYS
// points at entry_pages first, then the cheapest SEO wins, then the full
// overview. Short on purpose (3 pointers): a long menu defeats the "easy mode".

/** One next-step pointer: a plain-English label and the exact tool to call. */
export type NextStepPointer = { label: string, tool: string };

/**
 * The fixed, curated pointer list for a fully-set-up domain. Kept verbatim in
 * intent (entry_pages / striking_distance / dashboard) so the AI-landing-pages
 * capability is always surfaced. Returned as a fresh array each call so a caller
 * can never mutate the shared constant.
 *
 * @returns {NextStepPointer[]}
 */
export const readyNextSteps = (): NextStepPointer[] => [
   { label: 'See which pages AI search lands on', tool: 'entry_pages' },
   { label: 'Your quickest SEO wins', tool: 'striking_distance' },
   { label: 'Full cross-pillar overview', tool: 'dashboard' },
];

// --- ONBOARDING mode: install + unlock previews. -----------------------------
//
// When setup is incomplete, start_here is the "here is how you put s33k on your
// site, and here is what you unlock once it is on" tour. It carries the install
// snippet + per-platform steps inline (installing the script is the gating step
// for analytics) and a one-line preview of each of the 3 prebuilt reports as
// motivation to finish. None of this dumps live numbers (there are none yet); it
// previews the SHAPE of value so the user knows what they are working toward.

/** The install payload start_here surfaces inline in onboarding mode. */
export type InstallPayload = {
   /** The one-line <script> snippet to paste into the site head. */
   snippet: string,
   /** Full URL of the tracker script (so a client can show/verify the host). */
   scriptUrl: string,
   /** The per-domain tracking website id embedded in the snippet. */
   websiteId: string,
   /** Per-platform copy-paste install steps (raw HTML, GTM, WordPress, ...). */
   platforms: { platform: string, steps: string[] }[],
   /** One-line "what this does and why it is the gating step" note. */
   note: string,
};

/** A one-line preview of a prebuilt report shown as motivation during setup. */
export type UnlockPreview = {
   /** Stable key matching the ready-mode report card key. */
   key: 'analytics' | 'seo' | 'aeo',
   /** Friendly report name. */
   name: string,
   /** What the report will tell you once setup is done. */
   preview: string,
   /** The exact tool that produces it. */
   tool: string,
};

/**
 * The fixed 3-report unlock previews. Same three pillars (and tool names) as the
 * ready-mode report cards, so onboarding promises exactly what ready delivers.
 * Returned fresh each call so a caller can never mutate the shared constant.
 * @returns {UnlockPreview[]}
 */
export const buildUnlocks = (): UnlockPreview[] => [
   {
      key: 'analytics',
      name: 'Analytics',
      preview: 'Your traffic, where it comes from, and a real human-vs-bot split. Cookieless, no PII.',
      tool: 'dashboard',
   },
   {
      key: 'seo',
      name: 'SEO',
      preview: 'Your Google rank for every keyword you track, plus the quickest wins sitting just off page one.',
      tool: 'seo_report',
   },
   {
      key: 'aeo',
      name: 'AI Search (AEO)',
      preview: 'Whether ChatGPT, Claude, Gemini, and Perplexity send you visitors, and which pages they land on.',
      tool: 'aeo_report',
   },
];

/** The onboarding-mode payload: checklist + install + unlock previews + render. */
export type OnboardingResult = {
   mode: 'setup',
   domain: string,
   percentComplete: number,
   nextStep: string | null,
   nextTool: string | null,
   checklist: SetupStep[],
   install: InstallPayload,
   unlocks: UnlockPreview[],
   message: string,
   rendered: string,
};

/**
 * Build the staged onboarding walkthrough block. Plain-text, monospace, no color,
 * no em dash, so a client can print it verbatim (same style as the ready render
 * and the dashboard/daily_brief blocks). Stages it as: the checklist with the next
 * step called out, then the install snippet + the steps for the first platform,
 * then the unlock previews so the user sees what finishing buys them.
 *
 * @param {string} domain - The site being onboarded.
 * @param {number} percentComplete - 0..100 setup progress.
 * @param {SetupStep[]} checklist - The five setup steps.
 * @param {SetupStep | null} nextStep - The single next step (null when complete).
 * @param {InstallPayload} install - The tracking snippet + platform steps.
 * @param {UnlockPreview[]} unlocks - The 3 report previews.
 * @returns {string}
 */
const renderOnboarding = (
   domain: string,
   percentComplete: number,
   checklist: SetupStep[],
   nextStep: SetupStep | null,
   install: InstallPayload,
   unlocks: UnlockPreview[],
): string => {
   const out: string[] = [];
   out.push('=== START HERE ===');
   out.push(`Setting up ${domain}. ${percentComplete}% done. 5 minutes to value.`);
   out.push('');
   out.push('SETUP CHECKLIST:');
   checklist.forEach((s) => out.push(`   [${s.done ? 'x' : ' '}] ${s.title}`));
   out.push('');
   if (nextStep) {
      out.push('>> DO THIS NEXT:');
      out.push(`   ${nextStep.title}: ${nextStep.detail}`);
      out.push(`   Use ${nextStep.nextTool}.`);
      out.push('');
   }
   out.push('INSTALL S33K ON YOUR SITE (the gating step for analytics):');
   // Only print a paste line when there is a REAL snippet (the caller owns the domain and it has a
   // provisioned website id). With no real snippet we print the note instead of a broken placeholder
   // command, so nothing copyable here would silently collect nothing.
   if (install.snippet) {
      out.push(`   Paste this one line into your site head:`);
      out.push(`   ${install.snippet}`);
      if (install.platforms.length > 0) {
         const first = install.platforms[0];
         out.push(`   ${first.platform}:`);
         first.steps.forEach((step, i) => out.push(`     ${i + 1}. ${step}`));
         out.push('   Ask install_instructions for steps on WordPress, Webflow, Shopify, GTM, and more.');
      }
   } else {
      out.push(`   ${install.note}`);
   }
   out.push('');
   out.push('WHAT YOU UNLOCK WHEN SETUP IS DONE:');
   unlocks.forEach((u) => out.push(`   - ${u.name}: ${u.preview}  (${u.tool})`));
   out.push('');
   out.push('Finish the next step above, then call start_here again.');
   return out.join('\n');
};

/**
 * Assemble the full onboarding-mode result from the setup state + the resolved
 * install payload. Pure. The route calls this once it knows setup is incomplete
 * and has resolved the per-domain tracking website id for the snippet.
 *
 * @param {string} domain - The site being onboarded.
 * @param {SetupState} setup - The computed setup state (checklist + next step).
 * @param {InstallPayload} install - The tracking snippet + per-platform steps.
 * @returns {OnboardingResult}
 */
export const buildOnboarding = (domain: string, setup: SetupState, install: InstallPayload): OnboardingResult => {
   const next = setup.nextStep;
   const unlocks = buildUnlocks();
   const message = next
      ? `Setup for ${domain} is ${setup.percentComplete}% done. Do this next: ${next.title}. ${next.detail} `
         + `Use ${next.nextTool}. Installing s33k on your site is the gating step (snippet in install). `
         + 'Then call start_here again.'
      : `Setup for ${domain} is ${setup.percentComplete}% done. Call start_here again once you finish setup.`;
   const rendered = renderOnboarding(domain, setup.percentComplete, setup.steps, next, install, unlocks);
   return {
      mode: 'setup',
      domain,
      percentComplete: setup.percentComplete,
      nextStep: next ? next.title : null,
      nextTool: next ? next.nextTool : null,
      checklist: setup.steps,
      install,
      unlocks,
      message,
      rendered,
   };
};

// --- READY mode: the 3 prebuilt reports with LIVE teasers + the tour. --------
//
// Once a site is set up, start_here is the "here are your 3 reports with YOUR
// numbers, here is the data you now have, and here is what you can literally ask"
// tour. The teaser strings are computed by the route from already-loaded live
// data (Promise.allSettled so one failure degrades to 'Not available yet'); this
// layer only shapes the three cards and the curated see/ask lists, plus renders.

/** The graceful fallback when a teaser's underlying read failed. Never 500. */
export const TEASER_UNAVAILABLE = 'Not available yet';

// --- Pure teaser composers. --------------------------------------------------
//
// Each takes the already-loaded, already-scoped numbers the route gathered for a
// pillar and returns a single live one-liner. Pure (no IO), so they are unit-safe
// and the route can wrap each call in Promise.allSettled: a throw or a failed read
// degrades to TEASER_UNAVAILABLE without ever touching the others or 500ing.

/** The analytics teaser inputs: total visitors + the single biggest traffic source. */
export type AnalyticsTeaserInput = {
   visitors: number,
   period: string,
   topSourceName: string | null,
   topSourceVisitors: number,
};

/**
 * Compose the analytics teaser: total visitors over the window + the top source.
 * @param {AnalyticsTeaserInput} a - The loaded analytics numbers.
 * @returns {string}
 */
export const analyticsTeaser = (a: AnalyticsTeaserInput): string => {
   if (a.visitors <= 0) {
      return `No visitors measured over ${a.period} yet. Once the tracking script is live, this fills in.`;
   }
   const src = a.topSourceName
      ? `top source ${a.topSourceName} (${a.topSourceVisitors})`
      : 'no single top source yet';
   return `${a.visitors} visitor(s) over ${a.period}, ${src}.`;
};

/** The SEO teaser inputs: tracked count + on-page-one count + striking-distance count + rank-pending flag. */
export type SeoTeaserInput = {
   keywordsTracked: number,
   onPageOne: number,
   strikingDistance: number,
   // True when any tracked keyword's first Google rank check has not landed yet (keyword.updating).
   // When set we must say "first check running", never imply a rank-pending keyword is off page one.
   rankPending?: boolean,
};

/**
 * Compose the SEO teaser: keywords tracked, how many on page one, and how many
 * quick wins sit in striking distance. When a first rank check is still running
 * (rankPending), lead with that instead of a "0 on page one" that would wrongly
 * read as "not in the top 100" while the check is in flight.
 * @param {SeoTeaserInput} s - The loaded SEO numbers.
 * @returns {string}
 */
export const seoTeaser = (s: SeoTeaserInput): string => {
   if (s.keywordsTracked <= 0) {
      return 'No keywords tracked yet. Add the terms you want to rank for so s33k can watch your Google position.';
   }
   if (s.rankPending) {
      return `${s.keywordsTracked} keyword(s) tracked, first Google rank check in progress. `
         + 'Positions populate right after the next check.';
   }
   return `${s.keywordsTracked} keyword(s) tracked, ${s.onPageOne} on page one, `
      + `${s.strikingDistance} quick win(s) in striking distance.`;
};

/** The AEO teaser inputs: AI visitors, AI share of referred traffic, and the top engine. */
export type AeoTeaserInput = {
   aiVisitors: number,
   aiSharePct: number,
   topEngine: string | null,
   topEngineVisitors: number,
};

/**
 * Compose the AEO teaser: AI visitors, the AI share of referred traffic, and the
 * top AI engine sending them.
 * @param {AeoTeaserInput} a - The loaded AEO numbers.
 * @returns {string}
 */
export const aeoTeaser = (a: AeoTeaserInput): string => {
   if (a.aiVisitors <= 0) {
      return 'No measurable visitors from AI engines (ChatGPT, Claude, Gemini, Perplexity) yet. This is the leading AEO signal to grow.';
   }
   const engine = a.topEngine ? `, ${a.topEngine} top (${a.topEngineVisitors})` : '';
   return `${a.aiVisitors} AI-referred visitor(s), ${a.aiSharePct}% of referred traffic${engine}.`;
};

/** One ready-mode report card: name, what it tells you, the tool, and a live teaser. */
export type ReportCard = {
   key: 'analytics' | 'seo' | 'aeo',
   name: string,
   whatItTells: string,
   tool: string,
   teaser: string,
};

/** The three live teaser strings the route computes and hands the ready builder. */
export type ReportTeasers = {
   analytics: string,
   seo: string,
   aeo: string,
};

/**
 * Build the three report cards from the live teaser strings. The key/name/tool/
 * whatItTells are fixed (and match the unlock previews); only the teaser is live.
 * @param {ReportTeasers} teasers - The route-computed live teaser strings.
 * @returns {ReportCard[]}
 */
export const buildReportCards = (teasers: ReportTeasers): ReportCard[] => [
   {
      key: 'analytics',
      name: 'Analytics',
      whatItTells: 'Traffic, sources, and human-vs-bot.',
      tool: 'dashboard',
      teaser: teasers.analytics || TEASER_UNAVAILABLE,
   },
   {
      key: 'seo',
      name: 'SEO',
      whatItTells: 'Your Google rankings and quickest wins.',
      tool: 'seo_report',
      teaser: teasers.seo || TEASER_UNAVAILABLE,
   },
   {
      key: 'aeo',
      name: 'AI Search (AEO)',
      whatItTells: 'Whether AI engines send and cite you, and which pages they land on (entry_pages).',
      tool: 'aeo_report',
      teaser: teasers.aeo || TEASER_UNAVAILABLE,
   },
];

/**
 * The curated "data surfaces you now have" list. Short phrases, not tools: the
 * point is to make the breadth legible, not to dump the tool catalog. Returned
 * fresh each call. Only promises conversion reporting once a conversion goal
 * exists (goalCount > 0); otherwise it points the user at defining one, so the
 * list never claims a surface the user has not unlocked yet.
 * @param {number} [goalCount] - Number of conversion goals defined for the domain.
 * @returns {string[]}
 */
export const whatYouCanSee = (goalCount = 0): string[] => [
   'Google rank for every keyword you track',
   'Traffic and where it comes from, cookieless',
   'Real human vs bot split',
   'Which AI engines send visitors and which pages they land on',
   goalCount > 0
      ? 'Conversions and revenue by source, including AI'
      : 'Define a conversion goal to unlock conversion reporting (suggest_goals, then create_goal)',
   'Entry (landing) pages and their first-touch source',
   'Competitor share of voice for your keywords',
];

/**
 * The curated "questions you can literally say to your LLM" list. Concrete,
 * natural-language, each answerable by a real s33k tool. The route folds in the
 * dashboard's contextual suggestedQuestions on top of these (deduped).
 * @returns {string[]}
 */
export const questionsYouCanAsk = (): string[] => [
   'Give me my daily brief.',
   'What changed since yesterday?',
   'Which of my pages does ChatGPT send people to?',
   'What are my quickest SEO wins?',
   'Did AI search convert anyone last month?',
   'How much of my traffic is bots?',
   'Which keyword is closest to page one?',
];

/** The inputs the route hands the ready-mode builder, lifted from live data. */
export type ReadyInput = {
   domain: string,
   period: string,
   humanVisitors: number,
   aiReferredVisitors: number,
   topAction: string | null,
   /** The three live teaser strings (already degraded to a fallback on failure). */
   teasers: ReportTeasers,
   /** Extra contextual questions from the dashboard, folded into questionsYouCanAsk. */
   extraQuestions?: string[],
   /** True when a first Google rank check is still running (keyword.updating). Drives the gathering headline. */
   rankPending?: boolean,
   /** Number of conversion goals defined, so whatYouCanSee only promises conversion reporting once one exists. */
   goalCount?: number,
};

/** The ready-mode payload start_here returns when a domain is fully set up. */
export type ReadyResult = {
   mode: 'ready',
   domain: string,
   headline: string,
   reports: ReportCard[],
   whatYouCanSee: string[],
   questionsYouCanAsk: string[],
   topAction: string,
   nextSteps: NextStepPointer[],
   rendered: string,
};

/**
 * Compose the one-line "state of the site" headline from the live numbers.
 * Mirrors the dashboard headline's spirit (human visitors, AI-referred visitors)
 * but as a single sentence start_here can lead with.
 *
 * GATHERING-aware: when nothing has landed yet (no human visitors AND no
 * AI-referred visitors, or a rank check is still running), a flat "about 0
 * human visitor(s)" reads like a failure on a brand-new site that is in fact
 * working fine. Lead with momentum in that case ("tracking is live, the first
 * numbers are coming in"). Once any real number lands (N > 0), show the real
 * headline.
 *
 * @param {ReadyInput} d - The live numbers for the domain.
 * @returns {string}
 */
const composeHeadline = (d: ReadyInput): string => {
   // GATHERING only when nothing real has landed yet (no humans AND no AI referrals). A still-running
   // first rank check (rankPending) must NOT hide real traffic on an established site that simply added
   // one new keyword; in that case keep the real headline and just note the rank check is running.
   const gathering = d.humanVisitors <= 0 && d.aiReferredVisitors <= 0;
   if (gathering) {
      return `${d.domain}: tracking is live, the first numbers are coming in. Rankings populate after the next check; `
         + 'traffic shows as soon as the script sees visitors.';
   }
   const ai = d.aiReferredVisitors > 0
      ? `${d.aiReferredVisitors} AI-referred visitor(s)`
      : 'no AI-referred visitors yet';
   const rankClause = d.rankPending ? ' First rank check is running for new keywords.' : '';
   return `${d.domain} over ${d.period}: about ${d.humanVisitors} human visitor(s), ${ai}.${rankClause}`;
};

/**
 * Merge the fixed questionsYouCanAsk list with the dashboard's contextual
 * questions, deduped case-insensitively, fixed list first. Keeps the result
 * tight (the fixed six plus a few contextual ones) so it stays a menu, not a wall.
 * @param {string[]} extra - The dashboard's contextual question strings.
 * @returns {string[]}
 */
const mergeQuestions = (extra: string[]): string[] => {
   const base = questionsYouCanAsk();
   const seen = new Set(base.map((q) => q.trim().toLowerCase()));
   const merged = [...base];
   extra.forEach((q) => {
      const key = String(q || '').trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); merged.push(q); }
   });
   // Cap so the list stays a glanceable menu, not the full catalog.
   return merged.slice(0, 9);
};

/**
 * Build the ready-to-show plain-text tour. Matches the monospace, no-color,
 * no-em-dash style of the dashboard/daily_brief rendered blocks so a client can
 * print it verbatim: the headline, the 3 reports with teasers and the tool to run
 * each, the "what you can see" list, the "questions you can ask" list, and the one
 * top action.
 *
 * @param {string} headline - The composed state-of-the-site line.
 * @param {ReportCard[]} reports - The 3 report cards with live teasers.
 * @param {string[]} canSee - The curated data-surfaces list.
 * @param {string[]} canAsk - The merged questions list.
 * @param {string} topAction - The single highest-priority recommendation.
 * @returns {string}
 */
const renderReady = (
   headline: string,
   reports: ReportCard[],
   canSee: string[],
   canAsk: string[],
   topAction: string,
): string => {
   const out: string[] = [];
   out.push('=== START HERE ===');
   out.push(headline);
   out.push('');
   out.push('YOUR 3 REPORTS (with your own numbers):');
   reports.forEach((r) => {
      out.push(`   ${r.name}: ${r.whatItTells}`);
      out.push(`      ${r.teaser}`);
      out.push(`      Run it: ${r.tool}`);
   });
   out.push('');
   out.push('WHAT YOU CAN NOW SEE:');
   canSee.forEach((s) => out.push(`   - ${s}`));
   out.push('');
   out.push('QUESTIONS YOU CAN ASK (say any of these):');
   canAsk.forEach((q) => out.push(`   - "${q}"`));
   out.push('');
   out.push('>> DO THIS NEXT:');
   out.push(`   ${topAction}`);
   return out.join('\n');
};

/**
 * Assemble the full ready-mode result (headline + 3 report cards with live teasers
 * + the see/ask lists + topAction + curated pointers + rendered tour) from the
 * live numbers. Pure. The route calls this once setup is complete and it has
 * computed the three teasers (Promise.allSettled) and composed the dashboard.
 *
 * @param {ReadyInput} d - The live numbers + teasers for the domain.
 * @returns {ReadyResult}
 */
export const buildReady = (d: ReadyInput): ReadyResult => {
   const headline = composeHeadline(d);
   // The dashboard composer always sets a topAction, but guard for null so the
   // wire field is never empty (it is the whole point of "do this next").
   const topAction = d.topAction
      || 'No urgent gap this period. Ask dashboard for the full overview, or widen the window (period=90d).';
   const reports = buildReportCards(d.teasers);
   const canSee = whatYouCanSee(d.goalCount || 0);
   const canAsk = mergeQuestions(d.extraQuestions || []);
   const nextSteps = readyNextSteps();
   const rendered = renderReady(headline, reports, canSee, canAsk, topAction);
   return {
      mode: 'ready',
      domain: d.domain,
      headline,
      reports,
      whatYouCanSee: canSee,
      questionsYouCanAsk: canAsk,
      topAction,
      nextSteps,
      rendered,
   };
};
