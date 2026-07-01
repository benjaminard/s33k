import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { crawlSite } from '../../utils/site-crawl';
import { auditSite, SiteAuditResult } from '../../utils/site-audit';
import * as reportCache from '../../utils/report-cache';
import { allowCrawl } from '../../utils/crawl-rate-limit';

// GET /api/site-audit?domain=...
//
// A prioritized on-page / technical SEO issue list for a domain. Crawls the site and runs pure rules
// over each page (missing/long/short title, missing/long/short meta description, missing/multiple H1,
// duplicate titles across pages, thin content), returning each issue as {page, issue, severity,
// detail} sorted by severity. It only reports problems for the user's LLM to act on; it never edits a
// page and never queries an LLM. Reuses the suggest-goals crawl pattern.

type Resp = { domain?: string, report?: SiteAuditResult, note?: string, error?: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getSiteAudit(req, res, account);
}

const getSiteAudit = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   // Ownership gate first: the domain column is globally unique, so by-domain scoping cannot leak
   // across tenants. 403 before crawling anything for this domain.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   // Tenant-scoped cache (key begins with the resolved account ID), built only after the ownership
   // gate so a HIT only ever returns this caller's own report. site-audit is the most expensive of
   // these reports (a live crawl), so it benefits most. fresh=1 / nocache=1 bypass + refill.
   const cacheKey = reportCache.buildReportCacheKey('site-audit', req, account);
   if (!reportCache.wantsFresh(req)) {
      const hit = reportCache.get(cacheKey) as Resp | undefined;
      if (hit) { return res.status(200).json(hit); }
   }

   // Per-account crawl brake (audit area 2), applied only on a cache MISS (a HIT does no crawl, so it
   // should not consume crawl budget). Bounds how often the live-crawl audit can be looped per tenant.
   const rl = allowCrawl(account);
   if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many crawl requests. Please slow down.' });
   }

   try {
      const crawl = await crawlSite(domain);
      const report = auditSite(crawl.pages || []);
      const note = report.issueCount === 0
         ? `No on-page SEO issues found across ${report.pagesAudited} page(s) crawled. `
            + 'Either the pages are clean or the site blocked the crawl (check the crawl error).'
         : `${report.issueCount} issue(s) across ${report.pagesAudited} page(s): `
            + `${report.bySeverity.high} high, ${report.bySeverity.medium} medium, ${report.bySeverity.low} low. `
            + 'Work the high-severity items (missing titles and H1s) first.';
      // crawl.error is surfaced (not thrown) so a partial/blocked crawl still returns a usable answer.
      const payload: Resp = { domain, report, note, error: crawl.error || null };
      // Do NOT cache a blocked/partial crawl: caching crawl.error for the TTL would pin a transient
      // failure. Only a clean crawl (error null) is cached so a one-off block self-heals next call.
      if (!crawl.error) { reportCache.set(cacheKey, payload); }
      return res.status(200).json(payload);
   } catch (error) {
      console.log('[ERROR] Auditing site for ', domain, error);
      return res.status(400).json({ error: 'Error Auditing this Domain.' });
   }
};
