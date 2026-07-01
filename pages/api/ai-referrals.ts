import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, ReferralSource } from '../../utils/analytics';

type ByEngineRow = {
   engine: string,
   visitors: number,
}

type AiReferralsResponse = {
   domain?: string,
   period?: string,
   aiSources?: ReferralSource[],
   byEngine?: ByEngineRow[],
   totals?: {
      aiVisitors: number,
      allVisitors: number,
      aiSharePct: number,
   },
   allSources?: ReferralSource[],
   note?: string,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<AiReferralsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAiReferrals(req, res, account);
}

const getAiReferrals = async (req: NextApiRequest, res: NextApiResponse<AiReferralsResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '90d';

   try {
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      const { sources, error } = await getAnalyticsProvider().getReferralSources(domain, period);

      // When the analytics provider is unreachable, return a clean empty shape + a friendly
      // note rather than leaking the raw provider error string (which can carry an internal
      // host) into a user-facing field. Same 200 contract, just nothing to show yet.
      if (error) {
         return res.status(200).json({
            domain,
            period,
            aiSources: [],
            byEngine: [],
            totals: { aiVisitors: 0, allVisitors: 0, aiSharePct: 0 },
            allSources: [],
            note: 'AI referral data is temporarily unavailable; try again shortly.',
            error: null,
         });
      }

      // Visitor count per source, used for AI share and per-engine totals.
      const visitorsOf = (s: ReferralSource): number => Number(s.unique_visitors ?? 0);

      const aiSources = sources
         .filter((s) => s.isAI)
         .sort((a, b) => visitorsOf(b) - visitorsOf(a));

      // Aggregate AI visitors by normalized engine label. Per-engine pageviews are NOT
      // surfaced: the first-party provider does not return a per-referrer pageview count, so it
      // would always be 0, a false value (a visitor implies at least one pageview).
      const engineMap = new Map<string, ByEngineRow>();
      aiSources.forEach((s) => {
         const engine = s.engine || s.name || 'Unknown AI';
         const existing = engineMap.get(engine) || { engine, visitors: 0 };
         existing.visitors += visitorsOf(s);
         engineMap.set(engine, existing);
      });
      const byEngine = Array.from(engineMap.values()).sort((a, b) => b.visitors - a.visitors);

      const aiVisitors = aiSources.reduce((sum, s) => sum + visitorsOf(s), 0);
      const allVisitors = sources.reduce((sum, s) => sum + visitorsOf(s), 0);
      const aiSharePct = allVisitors > 0 ? Math.round((aiVisitors / allVisitors) * 1000) / 10 : 0;

      const allSources = [...sources].sort((a, b) => visitorsOf(b) - visitorsOf(a));

      return res.status(200).json({
         domain,
         period,
         aiSources,
         byEngine,
         totals: { aiVisitors, allVisitors, aiSharePct },
         allSources,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building AI Referrals for ', domain, error);
      return res.status(400).json({ error: 'Error Building AI Referrals for this Domain.' });
   }
};
