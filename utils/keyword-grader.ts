/**
 * Deterministic keyword grader (Rubric 1, the "General Keyword Quality Score", from keyword_grading.md).
 *
 * THE POINT: turn a loose set of candidate keywords (from the Firecrawl scrape) into the handful that
 * are actually worth tracking, by scoring each 1-100 from the SITE CRAWL + the keyword string alone.
 * No LLM, no API key: every dimension is computable from on-site text + string semantics, exactly as
 * the rubric is designed (external volume/difficulty are optional +/-10 modifiers we do not have, so
 * they default to neutral 0). This is what strips the nav/doc-chrome junk ("agents", "all guides",
 * "featured topics") and keeps the real terms ("infrastructure for ai", "fluid compute").
 *
 * Rubric 1 dimensions (weights sum to 100): G1 Business Relevance (28), G2 Intent/Commercial (22),
 * G3 Specificity/"Goldilocks" (18), G4 Topical Authority on-site (12), G5 AI-Answerability (12),
 * G6 Brand class (8). Hard cap: a relevance-orphan (G1 <= 2) caps the total at 35 and fails the gate.
 * Gate default 60 (the rubric's recommended starting gate for a new/low-authority site; configurable).
 */

export type CrawlPage = {
   url: string,
   title?: string,
   text: string,
};

export type GradedKeyword = {
   keyword: string,
   targetPage: string,
   score: number,
   pass: boolean,
   intent: 'transactional' | 'commercial' | 'informational' | 'none',
   reasons: string[],
   breakdown: { g1: number, g2: number, g3: number, g4: number, g5: number, g6: number },
};

export type GradeOptions = {
   businessName?: string,
   gate?: number,
   limit?: number,
};

export const DEFAULT_GATE = (() => {
   const raw = parseInt(process.env.KEYWORD_GRADE_GATE || '', 10);
   return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 60;
})();

// Intent modifier lexicons (rubric 2.3). Order matters: transactional > commercial > informational.
const TRANSACTIONAL = ['buy', 'demo', 'free trial', 'trial', 'sign up', 'signup', 'pricing', 'price', 'cost', 'get a quote', 'quote'];
const COMMERCIAL = ['best ', 'top ', 'review', ' vs ', ' versus ', 'alternative', 'comparison', 'compare', ' for '];
const INFORMATIONAL = [
   'how ', 'what ', 'why ', 'guide', 'guides', 'tutorial', 'examples', 'ideas',
   'faq', 'frequently asked', 'knowledge base', ' docs', 'documentation',
];

// Bare category / navigation-label / doc-chrome tokens (rubric 2.1 #2 head-noun + nav-label test).
// A keyword made only of these (with no real qualifier) describes a nav menu, not a search a buyer types.
const NAV_NOUNS = new Set([
   'home', 'about', 'contact', 'login', 'signin', 'pricing', 'docs', 'blog', 'press', 'careers', 'events',
   'tools', 'platform', 'platforms', 'app', 'apps', 'software', 'solutions', 'solution', 'product', 'products',
   'features', 'feature', 'resources', 'guides', 'guide', 'topics', 'latest', 'explore', 'showcase', 'overview',
   'dashboard', 'sandbox', 'domains', 'agents', 'agent', 'security', 'ship', 'sessions', 'investors', 'company',
   'team', 'partners', 'enterprise', 'support', 'help', 'community', 'updates', 'news', 'all', 'featured',
   'knowledge', 'base', 'documentation', 'questions', 'showcase', 'pricing',
]);

// Marketing-slogan / synthetic-string signals (rubric 2.2 #4): a candidate that reads like a tagline or a
// site section header, not a query a human or AI would type.
const SLOGAN_HINTS = [
   'hear from', 'comes with', 'pay off', 'backed by', 'incredible', 'showcase your', 'trade shows',
   'on-demand', 'upcoming', 'frequently asked', 'explore all', 'core platform', '0 ipo', 'receipts', 'anomalies',
];

const STOP = new Set([
   'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
   'your', 'our', 'is', 'are', 'it', 'that', 'this', 'you', 'we',
]);

const norm = (s: string): string => String(s || '')
   .toLowerCase()
   .replace(/[^a-z0-9\s&-]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();
const words = (s: string): string[] => norm(s).split(' ').filter(Boolean);
// The distinctive (non-stopword) tokens of a phrase, used for relevance/authority matching.
const contentTokens = (s: string): string[] => words(s).filter((w) => w.length > 2 && !STOP.has(w));

// A page is a "money page" (product/pricing/solution) by its URL path: relevance to such a page is the
// strongest signal (rubric G1 24-28 requires the topic appear on a product/pricing/solution page).
const MONEY_PATH = /(^\/$|\/(pricing|plans|product|products|solution|solutions|platform|features|enterprise|demo|signup|sign-up|get-started)(\/|$))/i;
const isMoneyPage = (url: string): boolean => {
   try { return MONEY_PATH.test(new URL(url).pathname); } catch { return false; }
};

type Corpus = {
   pages: { url: string, text: string, money: boolean, tokens: Set<string> }[],
   allText: string,
   moneyText: string,
};

const buildCorpus = (pages: CrawlPage[]): Corpus => {
   const built = (pages || []).map((p) => {
      const text = norm(`${p.title || ''} ${p.text || ''}`);
      return { url: p.url, text, money: isMoneyPage(p.url), tokens: new Set(words(text)) };
   });
   return {
      pages: built,
      allText: built.map((p) => p.text).join(' \n '),
      moneyText: built.filter((p) => p.money).map((p) => p.text).join(' \n '),
   };
};

// Fraction of a phrase's content tokens that appear anywhere in the corpus (0..1).
const tokenCoverage = (tokens: string[], haystack: string): number => {
   if (!tokens.length) { return 0; }
   const hits = tokens.filter((t) => haystack.includes(t)).length;
   return hits / tokens.length;
};

const detectIntent = (k: string): GradedKeyword['intent'] => {
   const padded = ` ${k} `;
   if (TRANSACTIONAL.some((m) => padded.includes(` ${m}`) || k.includes(m))) { return 'transactional'; }
   if (COMMERCIAL.some((m) => padded.includes(m))) { return 'commercial'; }
   if (INFORMATIONAL.some((m) => padded.includes(` ${m}`) || k.startsWith(m) || k.includes(m))) { return 'informational'; }
   return 'none';
};

/**
 * Grade one candidate keyword against the crawl. Returns the 1-100 score, pass/gate, intent, the
 * per-dimension breakdown, and human-readable reasons. Pure function of (keyword, corpus, options).
 */
const gradeOne = (keyword: string, targetPage: string, corpus: Corpus, businessTokens: string[], gate: number): GradedKeyword => {
   const k = norm(keyword);
   const w = words(k);
   const ctoks = contentTokens(k);
   const reasons: string[] = [];

   // --- G2 Intent & commercial value (22) ---
   const intent = detectIntent(k);
   const INTENT_POINTS: Record<GradedKeyword['intent'], number> = { transactional: 20, commercial: 17, informational: 8, none: 5 };
   const g2 = INTENT_POINTS[intent];
   if (intent !== 'none') { reasons.push(`${intent} intent`); }

   // --- G1 Business relevance (28): token coverage in the crawl, weighted by money-page presence ---
   const allCov = tokenCoverage(ctoks, corpus.allText);
   const moneyCov = corpus.moneyText ? tokenCoverage(ctoks, corpus.moneyText) : 0;
   // "nav-heavy": at least half a phrase's distinctive tokens are navigation / doc-chrome labels
   // (e.g. "knowledge base", "all guides", "explore vercel docs"). Such a phrase is a section label,
   // not a query a buyer types, so it is a relevance-orphan EVEN IF the words appear in the crawl (they
   // appear because the site has a nav menu / blog). Commercial/transactional intent overrides this,
   // so a real query like "best platform for startups" is NOT tanked just for containing "platform".
   const navTokenFrac = ctoks.length ? ctoks.filter((t) => NAV_NOUNS.has(t)).length / ctoks.length : 1;
   const navHeavy = navTokenFrac >= 0.5 && intent !== 'commercial' && intent !== 'transactional';
   let g1: number;
   if (navHeavy || ctoks.length === 0) {
      g1 = 2; // bare nav/category label -> relevance-orphan -> hard cap
      reasons.push('navigation/category label, not a buyer query');
   } else if (allCov < 0.25) {
      g1 = 1; // topic essentially absent -> relevance-orphan -> hard cap (the business does not offer this)
      reasons.push('topic essentially absent from the site (relevance-orphan)');
   } else if (allCov < 0.5) {
      g1 = 3;
      reasons.push('topic barely present in site content');
   } else if (moneyCov >= 0.5 && allCov >= 0.66) {
      g1 = 26;
      reasons.push('maps to a product/pricing page');
   } else if (allCov >= 0.75) {
      g1 = 20;
   } else {
      g1 = 12;
   }

   // --- G3 Specificity / Goldilocks (18): broad tests (2.1) + niche tests (2.2) ---
   let broad = 0;
   let niche = 0;
   if (w.length === 1) { broad += 1; }
   if (navHeavy) { broad += 1; }
   if (intent === 'none' && allCov < 0.66) { broad += 1; }
   // Site-dilution: tokens appear on a very high fraction of pages -> describes the whole site, not a page.
   if (corpus.pages.length >= 4 && ctoks.length) {
      const pageHitFrac = corpus.pages.filter((p) => ctoks.every((t) => p.tokens.has(t))).length / corpus.pages.length;
      if (pageHitFrac > 0.8) { broad += 1; }
   }
   if (w.length >= 6) { niche += 1; }
   if (SLOGAN_HINTS.some((s) => k.includes(s))) { niche += 1; reasons.push('reads like a slogan/section header'); }
   // Relevance-orphan: a distinctive qualifier token appears nowhere in the crawl.
   if (ctoks.length && ctoks.every((t) => !corpus.allText.includes(t))) { niche += 1; }
   let g3 = 16;
   if (broad >= 2 || niche >= 2) { g3 = 2; } else if (broad + niche === 1) { g3 = 12; }
   if (broad >= 2) { reasons.push('too broad/generic'); }
   if (niche >= 2) { reasons.push('too niche/synthetic'); }

   // --- G4 Topical authority on-site (12): how many pages cover the topic ---
   const pagesCovering = ctoks.length
      ? corpus.pages.filter((p) => tokenCoverage(ctoks, p.text) >= 0.66).length
      : 0;
   let g4 = 1;
   if (pagesCovering >= 4) { g4 = 11; } else if (pagesCovering >= 2) { g4 = 8; } else if (pagesCovering === 1) { g4 = 5; }

   // --- G5 AI-answerability / GEO (12): question/comparative shape + citable on-site material ---
   const aeoShape = /^(how|what|why|who|when|where|best)\b/.test(k) || /\b(vs|versus|alternative|comparison)\b/.test(k);
   const citable = /\b\d+%|\b\d{2,}\b/.test(corpus.allText); // crawl has stats/numbers somewhere
   let g5 = 4;
   if (aeoShape && citable) { g5 = 11; } else if (aeoShape || citable) { g5 = 7; }
   if (aeoShape) { reasons.push('question/comparison shape (AI-answerable)'); }

   // --- G6 Brand class (8) ---
   const branded = businessTokens.length > 0 && businessTokens.some((b) => w.includes(b));
   const competitorCompare = /\b(alternative|vs|versus|comparison)\b/.test(k) && !branded;
   let g6 = 7;
   if (competitorCompare) { g6 = 8; } else if (branded) { g6 = 4; }
   if (branded) { reasons.push('branded term (defense, not growth)'); }
   if (competitorCompare) { reasons.push('competitor-comparison (BOFU gold)'); }

   let score = g1 + g2 + g3 + g4 + g5 + g6;
   if (g1 <= 2) { score = Math.min(score, 35); } // hard cap on relevance-orphan
   score = Math.max(1, Math.min(100, score));

   return {
      keyword,
      targetPage: targetPage || '/',
      score,
      pass: score >= gate,
      intent,
      reasons,
      breakdown: { g1, g2, g3, g4, g5, g6 },
   };
};

/**
 * Grade + rank a set of candidate keywords against the site crawl, keeping the ones that clear the
 * gate (default 60). Returns ALL candidates graded (sorted best-first); the caller decides how many
 * passers to keep. Never throws. With no usable crawl/candidates, returns [] so the caller can fall
 * back to the heuristic.
 * @param {{keyword:string,targetPage:string}[]} candidates - raw candidate keywords (e.g. from Firecrawl).
 * @param {CrawlPage[]} pages - the scraped site pages (the crawl) used for relevance/authority.
 * @param {GradeOptions} opts - businessName (for brand detection), gate, limit.
 * @returns {GradedKeyword[]} graded candidates, sorted by score desc.
 */
export const gradeKeywords = (
   candidates: { keyword: string, targetPage?: string }[],
   pages: CrawlPage[],
   opts: GradeOptions = {},
): GradedKeyword[] => {
   if (!Array.isArray(candidates) || candidates.length === 0) { return []; }
   const gate = (typeof opts.gate === 'number' && opts.gate > 0) ? opts.gate : DEFAULT_GATE;
   const corpus = buildCorpus(pages || []);
   const businessTokens = contentTokens(opts.businessName || '');
   const seen = new Set<string>();
   const graded: GradedKeyword[] = [];
   for (const c of candidates) {
      const key = norm(c && c.keyword ? c.keyword : '');
      if (key && key.length >= 2 && !seen.has(key)) {
         seen.add(key);
         graded.push(gradeOne(c.keyword, (c.targetPage || '/'), corpus, businessTokens, gate));
      }
   }
   graded.sort((a, b) => b.score - a.score);
   return graded;
};

export default gradeKeywords;
