import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, EventRow } from '../../utils/analytics';

type EventsResponse = {
   domain?: string,
   period?: string,
   events?: EventRow[],
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<EventsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getEvents(req, res, account);
}

const getEvents = async (req: NextApiRequest, res: NextApiResponse<EventsResponse>, account?: Account | null) => {
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
      const { events, error } = await getAnalyticsProvider().getEvents(domain, period);
      return res.status(200).json({ domain, period, events, error });
   } catch (error) {
      console.log('[ERROR] Building Events for ', domain, error);
      return res.status(400).json({ error: 'Error Building Events for this Domain.' });
   }
};
