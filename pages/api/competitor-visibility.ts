import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { computeCompetitorVisibility, CompetitorRow, OutrankedKeyword } from '../../utils/competitor-visibility';

type CompetitorVisibilityResponse = {
   domain?: string,
   keywordsAnalyzed?: number,
   competitors?: CompetitorRow[],
   outrankedKeywords?: OutrankedKeyword[],
   note?: string | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<CompetitorVisibilityResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getCompetitorVisibility(req, res, account);
}

const getCompetitorVisibility = async (
   req: NextApiRequest,
   res: NextApiResponse<CompetitorVisibilityResponse>,
   account?: Account | null,
) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;

   // Verify the caller owns this domain before exposing any of its data. With MULTI_TENANT
   // off, scopeWhere returns {} so this matches the domain by name exactly as before.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      // Read this domain's keywords. Each keyword's lastResult holds the full stored SERP
      // page (every ranking URL, not just our own), so competitor share of voice needs no
      // new scrape and no LLM, just a tally over data already on disk.
      const allKeywords: Keyword[] = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
      const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));

      const { keywordsAnalyzed, competitors, outrankedKeywords } = computeCompetitorVisibility(
         keywords.map((kw) => ({ keyword: kw.keyword, position: kw.position, lastResult: kw.lastResult })),
         domain,
      );

      // SERP results only exist after a keyword has been scraped at least once. A brand-new
      // domain whose keywords have not refreshed yet has nothing to compare, so say so
      // rather than returning a misleading empty competitor set.
      const note = keywordsAnalyzed === 0
         ? 'No stored SERP results yet for this domain\'s keywords. Competitors appear once tracked keywords have been '
            + 'refreshed at least once (the scrape stores the full results page per keyword).'
         : null;

      return res.status(200).json({
         domain,
         keywordsAnalyzed,
         competitors,
         outrankedKeywords,
         note,
      });
   } catch (error) {
      console.log('[ERROR] Building Competitor Visibility for ', domain, error);
      return res.status(400).json({ error: 'Error Building Competitor Visibility for this Domain.' });
   }
};
