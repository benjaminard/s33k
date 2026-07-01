import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { buildWebVitals, WebVitalRow, WebVitalMetric, WebVitalPage } from '../../utils/web-vitals';

// GET /api/web-vitals?domain=&period=
//
// The Core Web Vitals report: for each field metric (LCP, CLS, INP, FID, FCP, TTFB) it reports
// the p75 (the percentile Google uses to score CWV) of the real-user samples captured by s33k.js,
// classified against Google's published thresholds into good / needs-improvement / poor, plus a
// per-page breakdown so a user sees WHICH pages are slow.
//
// Ownership-gated: only the owning tenant's events are read (owner_id scope via scopeWhere), and
// the domain must belong to the account or the route 403s before any read. Reads the first-party
// event store only; never queries an LLM.

type WebVitalsApiResponse = {
   domain?: string,
   period?: string,
   metrics?: WebVitalMetric[],
   worstPagesMetric?: string | null,
   worstPages?: WebVitalPage[],
   totalSamples?: number,
   note?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<WebVitalsApiResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getWebVitals(req, res, account);
}

const getWebVitals = async (req: NextApiRequest, res: NextApiResponse<WebVitalsApiResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // Ownership gate first: a domain belongs to exactly one account (domain is globally unique),
      // so by-domain scoping cannot leak across tenants. 403 before any pillar read.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      // periodStartMs clamps the lookback at 365 days, the shared DoS bound, so a hostile
      // period= cannot pull the whole event table into memory.
      const cutoff = new Date(periodStartMs(period, Date.now())).toJSON();
      const rows = await S33kEvent.findAll({
         // Human-only by default: bot/datacenter hits are excluded (is_bot stamped at ingest), so
         // the performance picture reflects real visitors, matching the other analytics reports.
         where: { domain, type: 'webvital', is_bot: false, created: { [Op.gte]: cutoff }, ...scopeWhere(account) },
         raw: true,
      }) as unknown as WebVitalRow[];

      const report = buildWebVitals(rows);
      return res.status(200).json({
         domain,
         period,
         metrics: report.metrics,
         worstPagesMetric: report.worstPagesMetric,
         worstPages: report.worstPages,
         totalSamples: report.totalSamples,
         note: report.note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Web Vitals for ', domain, error);
      return res.status(400).json({ error: 'Error Building Web Vitals for this Domain.' });
   }
};
