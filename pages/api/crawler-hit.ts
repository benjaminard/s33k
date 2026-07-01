import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import CrawlerHit from '../../database/models/crawlerHit';
import type Account from '../../database/models/account';
import { classifyCrawler, CrawlerClassification } from '../../utils/ai-crawlers';
import { MAX_CRAWLER_PATH_LEN, MAX_CRAWLER_UA_LEN } from '../../utils/limits';

type CrawlerHitResponse = {
   recorded?: boolean,
   classification?: CrawlerClassification,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<CrawlerHitResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   // FEATURE GATE (security review #4): the crawler-hit ingest is dormant by default. No
   // first-party feeder ships yet (the on-site reporter was deferred), so leaving an open
   // write path invites storage abuse for zero current benefit. It stays disabled until an
   // operator explicitly turns it on alongside a real, rate-aware feeder.
   if (process.env.CRAWLER_INGEST_ENABLED !== 'true') {
      return res.status(403).json({ error: 'Crawler-hit ingest is disabled. Set CRAWLER_INGEST_ENABLED=true to enable.' });
   }
   return recordCrawlerHit(req, res, account);
}

const recordCrawlerHit = async (req: NextApiRequest, res: NextApiResponse<CrawlerHitResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   // Cap the free-text fields so an authenticated caller cannot push unbounded blobs into the
   // TEXT columns (security review #4). Real paths/UAs are well under these limits.
   const path = typeof body.path === 'string' ? body.path.slice(0, MAX_CRAWLER_PATH_LEN) : '';
   const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, MAX_CRAWLER_UA_LEN) : '';

   if (!domain) {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   if (!userAgent) {
      return res.status(400).json({ error: 'userAgent is Required!' });
   }

   try {
      // A crawler hit is tenant data keyed by domain. Confirm the caller owns the domain
      // before recording, so one account cannot write hit rows against another's domain.
      // With MULTI_TENANT off, scopeWhere returns {} and this is the existing lookup-by-domain.
      const owned = await resolveDomainAccess(account, domain, { write: true });
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }
      // Store the canonical owned row's domain, not the raw request string. resolveDomainAccess()
      // accepts variants like "www.Example.com" by canonicalizing internally; persisting owned.domain
      // keeps CrawlerHit rows joinable to every read/export/delete path that keys on Domain.domain.
      const storedDomain = owned.domain;

      const classification = classifyCrawler(userAgent);
      // Only persist a row when the user-agent is a recognized crawler. Normal
      // browser traffic is classified and reported back, but never stored.
      if (classification.isCrawler) {
         await CrawlerHit.create({
            domain: storedDomain,
            bot: classification.bot ?? '',
            owner: classification.owner ?? '',
            isAiEngine: classification.isAiEngine,
            path,
            userAgent,
            hitAt: new Date().toJSON(),
         });
      }
      return res.status(200).json({ recorded: classification.isCrawler, classification, error: null });
   } catch (error) {
      console.log('[ERROR] Recording Crawler Hit for ', domain, error);
      return res.status(400).json({ error: 'Error Recording Crawler Hit for this Domain.' });
   }
};
