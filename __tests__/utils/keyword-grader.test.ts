/**
 * Tests for utils/keyword-grader.ts (deterministic Rubric 1 from keyword_grading.md).
 *
 * Drives the REAL set of 50 candidates Firecrawl returned for vercel.com against a synthetic Vercel-
 * like crawl, and asserts the behavior the rubric promises: the nav/doc-chrome/slogan junk fails the
 * gate, the genuinely relevant mid-tail product terms pass, the good terms outrank the junk, a
 * relevance-orphan is hard-capped, and brand terms are classified. No network, no LLM.
 */

import { gradeKeywords, CrawlPage } from '../../utils/keyword-grader';

// A small but realistic Vercel-like crawl: a money homepage + product/pricing/AI pages whose text
// genuinely covers the good topics (so relevance + topical authority score them up), plus thinner pages.
const VERCEL_CRAWL: CrawlPage[] = [
   { url: 'https://vercel.com/', title: 'Vercel: The AI Cloud', text: 'Vercel is the ai cloud and the infrastructure for ai. Build and deploy agentic infrastructure, ai workloads, and ai apps. Fluid compute scales your app and controls your costs. The ai sdk and the agent stack power modern applications. Trusted by 40% of the top startups. Security by default with platform firewall.' },
   { url: 'https://vercel.com/pricing', title: 'Pricing', text: 'Pricing for fluid compute, ai workloads, and the ai cloud. Plans for startups and enterprise. Infrastructure for ai with platform firewall and security by default. 99% uptime.' },
   { url: 'https://vercel.com/ai', title: 'Infrastructure for AI', text: 'Infrastructure for ai: agentic infrastructure, ai workloads, the ai sdk, agent stack, vercel agent. Build with the ai sdk today. Fluid compute for ai workloads. Over 100000 developers.' },
   { url: 'https://vercel.com/products/fluid-compute', title: 'Fluid Compute', text: 'Fluid compute is efficient serverless compute. Scale your app, control your costs. Server-side and partial pre-rendering. Business-critical apis.' },
   { url: 'https://vercel.com/startups', title: 'Vercel for Startups', text: 'Vercel for startups: the ai cloud for early-stage teams. Fluid compute, ai workloads, infrastructure for ai. Backed by incredible investors.' },
   { url: 'https://vercel.com/security', title: 'Security', text: 'Security by default. Platform firewall. Anomalies investigated automatically. Business-critical apis protected.' },
   { url: 'https://vercel.com/blog', title: 'Blog', text: 'Latest news, events, guides, and featured topics. Explore all guides. Knowledge base and frequently asked questions.' },
   { url: 'https://vercel.com/about', title: 'About', text: 'About us. Press. Individual investors. Trade shows and conferences. Upcoming events. On-demand sessions. Showcase your work.' },
];

const CANDIDATES = [
   'domains', 'scale your app control your costs', 'sandbox', 'vercel for startups', 'a unified platform for 0 ipo',
   'all guides', 'open source software', 'frequently asked questions', 'agentic infrastructure', 'agents', 'press',
   'explore all', 'apps', 'hear from teams building on vercel', 'platforms', 'latest', 'knowledge base', 'featured topics',
   'featured guides', 'explore vercel docs', 'infrastructure for ai', 'the ai cloud', 'build with the ai sdk today',
   'security by default', 'platform firewall', 'open source software by vercel', 'agent stack', 'core platform', 'security',
   'vercel ship 26', 'ship', 'vercel agent', 'anomalies investigated automatically', 'it comes with receipts', 'about us',
   'backed by incredible investors', 'individual investors', 'fluid compute', 'efficiency gains that pay off', 'ai workloads',
   'business-critical apis', 'server-side and partial pre-rendering', 'tools', 'events', 'upcoming events', 'on-demand sessions',
   'trade shows & conferences', 'ai sdk', 'shipped on vercel', 'showcase your work',
].map((keyword) => ({ keyword, targetPage: '/' }));

const grade = () => gradeKeywords(CANDIDATES, VERCEL_CRAWL, { businessName: 'Vercel', gate: 60 });

describe('utils/keyword-grader (Rubric 1)', () => {
   it('fails the obvious nav/doc-chrome/slogan junk at the gate', () => {
      const byKw = new Map(grade().map((g) => [g.keyword, g]));
      const junk = ['domains', 'sandbox', 'agents', 'apps', 'platforms', 'latest', 'press', 'ship', 'tools', 'events',
         'all guides', 'knowledge base', 'featured guides', 'featured topics', 'explore vercel docs', 'about us',
         'it comes with receipts', 'backed by incredible investors', 'individual investors', 'trade shows & conferences'];
      junk.forEach((k) => {
         const g = byKw.get(k);
         expect(g).toBeDefined();
         expect(g && g.pass).toBe(false);
      });
   });

   it('passes the genuinely relevant mid-tail product terms (crawl-supported)', () => {
      const byKw = new Map(grade().map((g) => [g.keyword, g]));
      const good = ['infrastructure for ai', 'the ai cloud', 'fluid compute', 'ai workloads', 'agentic infrastructure', 'vercel for startups'];
      good.forEach((k) => {
         const g = byKw.get(k);
         expect(g).toBeDefined();
         expect(g && g.pass).toBe(true);
      });
   });

   it('ranks the good terms above the junk', () => {
      const ranked = grade();
      const rankOf = (k: string) => ranked.findIndex((g) => g.keyword === k);
      // every good term outranks every junk term
      expect(rankOf('infrastructure for ai')).toBeLessThan(rankOf('agents'));
      expect(rankOf('fluid compute')).toBeLessThan(rankOf('all guides'));
      expect(rankOf('the ai cloud')).toBeLessThan(rankOf('about us'));
   });

   it('keeps far fewer than the original 50 (the junk filter actually fires)', () => {
      const passers = grade().filter((g) => g.pass);
      expect(passers.length).toBeGreaterThan(3);
      expect(passers.length).toBeLessThan(25); // not "everything passes"
   });

   it('hard-caps a relevance-orphan (topic absent from the crawl) below the gate', () => {
      const [orphan] = gradeKeywords(
         [{ keyword: 'soc 2 compliance for dogwalkers in canada', targetPage: '/' }],
         VERCEL_CRAWL,
         { businessName: 'Vercel', gate: 60 },
      );
      expect(orphan.score).toBeLessThanOrEqual(35);
      expect(orphan.pass).toBe(false);
   });

   it('classifies a branded term and a competitor-comparison term', () => {
      const [branded] = gradeKeywords([{ keyword: 'vercel agent' }], VERCEL_CRAWL, { businessName: 'Vercel' });
      expect(branded.reasons.join(' ')).toMatch(/branded/i);
      const [compare] = gradeKeywords([{ keyword: 'netlify alternative' }], VERCEL_CRAWL, { businessName: 'Vercel' });
      expect(compare.intent).toBe('commercial');
      expect(compare.breakdown.g6).toBe(8); // competitor-comparison max
   });

   it('returns [] for no candidates (caller falls back to heuristic)', () => {
      expect(gradeKeywords([], VERCEL_CRAWL, {})).toEqual([]);
   });
});
