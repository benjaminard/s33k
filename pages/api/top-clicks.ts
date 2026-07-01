import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { eventPeriodCutoff, buildTopClicks, EventRow, TopClickRow } from '../../utils/eventReports';

// GET /api/top-clicks?domain=&period=
//
// The read half of autocapture clicks. Reports the most-clicked elements on a domain,
// each by its visible text + CSS selector, with a per-page breakdown. Ownership-gated:
// the caller must own the domain, and only that tenant's events are read (owner_id scope).

type TopClicksResponse = {
   domain?: string,
   period?: string,
   clicks?: TopClickRow[],
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<TopClicksResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getTopClicks(req, res, account);
}

const getTopClicks = async (req: NextApiRequest, res: NextApiResponse<TopClicksResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // Ownership gate: 403 (and read nothing) unless the caller owns this domain.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      const cutoff = eventPeriodCutoff(period);
      const rows = await S33kEvent.findAll({
         // Human-only by default: exclude datacenter/bot hits (is_bot stamped at ingest).
         where: { domain, type: 'click', is_bot: false, created: { [Op.gte]: cutoff }, ...scopeWhere(account) },
         raw: true,
      }) as unknown as EventRow[];

      return res.status(200).json({ domain, period, clicks: buildTopClicks(rows), error: null });
   } catch (error) {
      console.log('[ERROR] Building Top Clicks for ', domain, error);
      return res.status(400).json({ error: 'Error Building Top Clicks for this Domain.' });
   }
};
