import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { eventPeriodCutoff, buildConversionsBySource, EventRow, ConversionSourceRow } from '../../utils/eventReports';

// GET /api/conversions?domain=&period=&event=
//
// The read half of conversion attribution by first-touch source. Answers "which traffic
// sources actually drive your conversions" with no GA4 setup: s33k already stamps a
// first-touch source ('direct' | 'referral' | 'organic-search' | 'ai', or a bare referral
// host) on every autocaptured event at ingest, so attributing a conversion to its source is a
// pure group-by here. event defaults to 'form_submit' (the autocaptured conversion) but any
// captured event type can be chosen.
//
// Ownership-gated; only the owning tenant's events are read (owner_id scope). Never 500s: a
// failure building a sub-signal degrades to an honest note, not a stack trace.

type ConversionsResponse = {
   domain?: string,
   period?: string,
   event?: string,
   conversions?: ConversionSourceRow[],
   totalConversions?: number,
   topSource?: { source: string, count: number } | null,
   conversionRateNote?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ConversionsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getConversions(req, res, account);
}

const getConversions = async (req: NextApiRequest, res: NextApiResponse<ConversionsResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';
   // The conversion event type to attribute. Defaults to the autocaptured form_submit.
   const event = (typeof req.query.event === 'string' && req.query.event.trim()) ? req.query.event.trim() : 'form_submit';

   try {
      // Verify the caller owns this domain before exposing any of its data. With MULTI_TENANT
      // off, scopeWhere returns {} so this matches the domain by name exactly as before.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      // Load the window's events for this domain. We read ALL types (not just the conversion
      // type) because the conversion-rate denominator needs the per-source session base, which
      // any event contributes to. The aggregation filters to the conversion type internally.
      const cutoff = eventPeriodCutoff(period);
      const rows = await S33kEvent.findAll({
         // Human-only by default: exclude datacenter/bot hits (is_bot stamped at ingest).
         where: { domain, is_bot: false, created: { [Op.gte]: cutoff }, ...scopeWhere(account) },
         raw: true,
      }) as unknown as EventRow[];

      const { conversions, totalConversions, topSource, conversionRateNote } = buildConversionsBySource(rows, event);
      return res.status(200).json({
         domain,
         period,
         event,
         conversions,
         totalConversions,
         topSource,
         conversionRateNote,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Conversions for ', domain, error);
      return res.status(400).json({ error: 'Error Building Conversions for this Domain.' });
   }
};
