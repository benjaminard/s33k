import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, SummaryResult } from '../../utils/analytics';
import { periodStartMs } from '../../utils/period';
import { sessionize, humanBotSplit, EventLike } from '../../utils/sessionize';

// When the raw provider total and the first-party human count diverge by more than this share,
// surface the explanatory note so the bare provider number is never mistaken for the real
// human number. 0.25 = a 25% gap, the threshold the task specifies.
const DIVERGENCE_THRESHOLD = 0.25;

type SummaryResponse = {
   domain?: string,
   period?: string,
   summary?: Omit<SummaryResult, 'error'>,
   // The RAW provider visitor total (INCLUDES bots). Mirrors summary.visitors for back-compat.
   visitorsRaw?: number,
   // The datacenter-filtered REAL human visitor count, from the same first-party is_bot path
   // human_traffic / start_here / dashboard use, so all four agree. This is the labeled real number.
   humanVisitors?: number,
   // Set only when visitorsRaw and humanVisitors diverge by more than DIVERGENCE_THRESHOLD, so a
   // reader of the bare raw total is told plainly that humanVisitors is the number to trust.
   note?: string,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<SummaryResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getSummary(req, res, account);
}

const getSummary = async (req: NextApiRequest, res: NextApiResponse<SummaryResponse>, account?: Account | null) => {
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
      const { error, ...summary } = await getAnalyticsProvider().getSummary(domain, period);

      // The provider's `summary.visitors` is the RAW total and INCLUDES bots (datacenter traffic a
      // JS pageview tracker cannot tell apart from a person). Alongside it, compute the canonical
      // HUMAN count from the SAME first-party is_bot path human-traffic.ts uses (sessionize the
      // owned s33k_event rows, then humanBotSplit), so this route stops reporting a bot-inflated
      // "visitors" number while the other surfaces report the real one. Scoped with scopeWhere
      // AFTER resolveDomainAccess so it can never read another tenant's events.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const eventRows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const split = humanBotSplit(sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike)));

      const visitorsRaw = summary.visitors;
      const humanVisitors = split.human;
      // Only fire the note on a real divergence, and only when the raw total is non-zero (avoid a
      // divide-by-zero and a spurious note on an empty window). The human count is the trustworthy one.
      const diverges = visitorsRaw > 0 && Math.abs(visitorsRaw - humanVisitors) / visitorsRaw > DIVERGENCE_THRESHOLD;
      const note = diverges
         ? 'Raw provider total counts differently and includes bots; humanVisitors is the datacenter-filtered first-party number to trust.'
         : undefined;

      return res.status(200).json({ domain, period, summary, visitorsRaw, humanVisitors, note, error });
   } catch (error) {
      console.log('[ERROR] Building Summary for ', domain, error);
      return res.status(400).json({ error: 'Error Building Summary for this Domain.' });
   }
};
