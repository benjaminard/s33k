import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import { crawlSite } from '../../utils/site-crawl';
import type { PageSummary } from '../../utils/site-crawl';
import { computeContentGaps, ContentGapItem } from '../../utils/content-gap';
import { allowCrawl } from '../../utils/crawl-rate-limit';

// GET /api/content-gap?domain=&competitor=
//
// The "what should I write next" SEO list. Crawls the COMPETITOR's site to derive the topics they
// cover (a topic = the page slug-as-phrase, or the title head before a separator), crawls YOUR site
// (plus your tracked keywords/target pages as extra covered topics) to derive what you already
// cover, and returns the competitor topics with NO close match in yours: the content gaps. Each gap
// carries the competitor url and derived topic, sorted by how content-rich the competitor page looks
// (excerpt length), richest first. Pure crawl-based string comparison. Never queries an LLM, no
// external API.

type Resp = {
   domain?: string,
   competitor?: string,
   total?: number,
   gaps?: ContentGapItem[],
   note?: string,
   error?: string | null,
};

// Tracked keywords and their target pages are an extra, authoritative source of "topics you already
// cover": you would not be tracking a keyword for a page you have not written. Folding them in keeps
// the gap list from flagging a topic you already own but whose page the crawler happened to miss.
const keywordsAsYourTopics = async (domain: string, account?: Account | null): Promise<PageSummary[]> => {
   const rows = await Keyword.findAll({
      where: { domain, ...scopeWhere(account) },
      attributes: ['keyword', 'target_page'],
   });
   return rows.map((k) => {
      const p = k.get({ plain: true }) as Record<string, unknown>;
      const keyword = String(p.keyword || '');
      const targetPage = String(p.target_page || '');
      // Reuse the PageSummary shape so deriveTopic can run uniformly. The keyword phrase is the
      // topic-bearing title; target_page (if any) is the path so a slug-derived topic also matches.
      return {
         url: targetPage,
         // The topic for a tracked keyword is the KEYWORD PHRASE itself (authoritative), so derive
         // the slug from the keyword, not from target_page. A target_page is often an abbreviated
         // slug (e.g. "/seismic-alt") that only partially token-matches "seismic alternative" and
         // would slip past the stricter isCovered overlap rule, re-flagging a topic you already own.
         path: `/${keyword.replace(/\s+/g, '-')}`,
         title: keyword,
         metaDescription: '',
         h1: [],
         h2: [],
         excerpt: '',
      } as PageSummary;
   });
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getContentGap(req, res, account);
}

const getContentGap = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   const competitor = typeof q.competitor === 'string' ? q.competitor : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   if (!competitor) { return res.status(400).json({ error: 'Competitor is Required!' }); }

   // Verify the caller owns the domain they are running the analysis FOR before reading its keyword
   // data. scopeWhere lets admin / MULTI_TENANT-off callers match any domain and limits a tenant to
   // their own. The competitor is a public site we only crawl, never a tracked domain, so it needs
   // no ownership check.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   // Per-account crawl brake (audit area 2). content-gap is the heaviest crawl route: it fetches BOTH
   // your site AND an arbitrary, unowned competitor (up to ~50 outbound fetches), so it is the prime
   // amplifier candidate. Bound how often one account can run it.
   const rl = allowCrawl(account);
   if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many crawl requests. Please slow down.' });
   }

   try {
      // Crawl both sites and pull your tracked-keyword topics in parallel. crawlSite never throws;
      // it surfaces unreachability as a .error and an empty/partial page list.
      const [competitorCrawl, yourCrawl, keywordTopics] = await Promise.all([
         crawlSite(competitor),
         crawlSite(domain),
         keywordsAsYourTopics(domain, account),
      ]);

      const yourTopics: PageSummary[] = [...(yourCrawl.pages || []), ...keywordTopics];
      const gaps = computeContentGaps(yourTopics, competitorCrawl.pages || []);

      // Bubble up a crawl problem so the LLM can explain a thin/empty result honestly rather than
      // implying the competitor simply has no gaps.
      const crawlError = competitorCrawl.error || yourCrawl.error || null;
      let note: string;
      if ((competitorCrawl.pages || []).length === 0) {
         note = `Could not read any pages from ${competitor}. It may be unreachable or blocking crawlers, so no gaps could be derived.`;
      } else if (gaps.length === 0) {
         note = `No content gaps found: every topic on ${competitor} has a close match on ${domain}.`;
      } else {
         note = `Found ${gaps.length} topic(s) ${competitor} covers that ${domain} does not, richest competitor pages first. `
            + 'Each is a candidate page to write. Topics are derived from page slugs and titles, not an LLM.';
      }

      return res.status(200).json({
         domain,
         competitor,
         total: gaps.length,
         gaps,
         note,
         error: crawlError,
      });
   } catch (error) {
      console.log('[ERROR] Building Content Gap for ', domain, 'vs', competitor, error);
      return res.status(400).json({ error: 'Error Building Content Gap for this Domain.' });
   }
};
