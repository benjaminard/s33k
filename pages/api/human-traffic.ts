import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { getAnalyticsProvider } from '../../utils/analytics';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike } from '../../utils/sessionize';
import { estimateHumanTraffic, HumanTrafficEstimate } from '../../utils/bot-filter';

type HumanTrafficResponse = {
   domain?: string,
   period?: string,
   estimate?: Omit<HumanTrafficEstimate, 'error'>,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<HumanTrafficResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getHumanTraffic(req, res, account);
}

const getHumanTraffic = async (req: NextApiRequest, res: NextApiResponse<HumanTrafficResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      // Prefer the FIRST-PARTY is_bot split: the source IP is classified as datacenter-or-not at ingest
      // (the signal a JS pageview tracker cannot see). Sessionizing these gives the same human number as
      // human_analytics, start_here, and the dashboard headline, so all four agree. The provider path is
      // only the fallback estimateHumanTraffic reaches when no first-party sessions exist (and only when
      // the provider exposes page-grain bounce); otherwise it returns an honest degraded shape, never a
      // fabricated 0-bots / 100%-human.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const eventRows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const sessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike));

      const { error, ...estimate } = await estimateHumanTraffic(getAnalyticsProvider(), domain, period, sessions);
      return res.status(200).json({ domain, period, estimate, error });
   } catch (error) {
      console.log('[ERROR] Estimating Human Traffic for ', domain, error);
      return res.status(400).json({ error: 'Error Estimating Human Traffic for this Domain.' });
   }
};
