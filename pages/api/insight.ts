import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import { getCountryInsight, getKeywordsInsight, getPagesInsight } from '../../utils/insight';
import { summarizeInsight, InsightSummary, INSIGHT_MAX_LIMIT } from '../../utils/insight-summary';
import { fetchDomainSCData, getSearchConsoleApiInfo, readLocalSCData, hasSearchConsoleCredentials } from '../../utils/searchConsole';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import Domain from '../../database/models/domain';

type SCInsightRes = {
   data: InsightDataType | InsightSummary | null,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomainSearchConsoleInsight(req, res, account);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const getDomainSearchConsoleInsight = async (req: NextApiRequest, res: NextApiResponse<SCInsightRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') return res.status(400).json({ data: null, error: 'Domain is Missing.' });

   // SUMMARY-FIRST AND BOUNDED BY DEFAULT (the entry-pages convention). The raw insight payload on
   // a real Search Console property is unbounded (hundreds of zero-click keyword rows plus full
   // pages/countries/days arrays, ~113KB observed) and overflowed the consuming LLM on its first
   // real use. detail=true is the escape hatch for the full arrays; limit clamps to
   // 1..INSIGHT_MAX_LIMIT and widens/narrows the keyword and page lists.
   const detail = req.query.detail === 'true' || req.query.detail === '1';
   const rawLimit = Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '', 10);
   const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(INSIGHT_MAX_LIMIT, rawLimit)) : undefined;
   const shapeInsight = (full: InsightDataType): InsightDataType | InsightSummary => (detail ? full : summarizeInsight(full, limit));

   // Resolve access by the CANONICAL domain only. The legacy slug-decode fallback ("-" -> ".",
   // "_" -> "-") was removed (third adversarial review): with registration canonicalized and
   // resolveDomainAccess canonicalizing internally, the decode is dead code AND a latent escape
   // vector (it could re-derive a different host after the share-key gate already checked canonical).
   // resolveDomainAccess is the per-domain chokepoint: admin / MULTI_TENANT-off callers match any
   // domain, a tenant only their own (M2: owned OR shared). It also guards the local-SC-file read below.
   const ownedDomain: Domain | null = await resolveDomainAccess(account, req.query.domain as string);
   if (!ownedDomain) {
      return res.status(403).json({ data: null, error: 'Domain not found for this account' });
   }
   // Drive all downstream reads off the row we actually resolved, not the request string, so the
   // SC-file read and logs use the domain that passed the access check.
   const domainname = ownedDomain.domain;
   const getInsightFromSCData = (localSCData: SCDomainDataType): InsightDataType => {
      const { stats = [] } = localSCData;
      const countries = getCountryInsight(localSCData);
      const keywords = getKeywordsInsight(localSCData);
      const pages = getPagesInsight(localSCData);
      return { pages, keywords, countries, stats };
   };

   // First try and read the  Local SC Domain Data file.
   const localSCData = await readLocalSCData(domainname);

   if (localSCData) {
      const oldFetchedDate = localSCData.lastFetched;
      const fetchTimeDiff = new Date().getTime() - (oldFetchedDate ? new Date(oldFetchedDate as string).getTime() : 0);
      if (localSCData.stats && localSCData.stats.length && fetchTimeDiff <= 86400000) {
         const response = getInsightFromSCData(localSCData);
         return res.status(200).json({ data: shapeInsight(response) });
      }
   }

   // If the Local SC Domain Data file does not exist, fetch from Googel Search Console.
   try {
      const domainObj: DomainType = ownedDomain.get({ plain: true });
      const scDomainAPI = await getSearchConsoleApiInfo(domainObj);
      if (!hasSearchConsoleCredentials(scDomainAPI)) {
         return res.status(200).json({ data: null, error: 'Google Search Console is not Integrated.' });
      }
      const scData = await fetchDomainSCData(domainObj, scDomainAPI);
      const response = getInsightFromSCData(scData);
      return res.status(200).json({ data: shapeInsight(response) });
   } catch (error) {
      console.log('[ERROR] Getting Domain Insight: ', domainname, error);
      return res.status(400).json({ data: null, error: 'Error Fetching Stats from Google Search Console.' });
   }
};
