import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { eventPeriodCutoff, buildFormSubmissions, EventRow, FormSubmissionRow } from '../../utils/eventReports';

// GET /api/form-submissions?domain=&period=
//
// The read half of autocapture form submissions. Reports how often each form was
// submitted on a domain (by form id/name) with a per-page breakdown. It records THAT a
// form was submitted, never any field value. Ownership-gated; only the owning tenant's
// events are read (owner_id scope).

type FormSubmissionsResponse = {
   domain?: string,
   period?: string,
   forms?: FormSubmissionRow[],
   totalSubmissions?: number,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<FormSubmissionsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getFormSubmissions(req, res, account);
}

const getFormSubmissions = async (req: NextApiRequest, res: NextApiResponse<FormSubmissionsResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      const cutoff = eventPeriodCutoff(period);
      const rows = await S33kEvent.findAll({
         // Human-only by default: exclude datacenter/bot hits (is_bot stamped at ingest).
         where: { domain, type: 'form_submit', is_bot: false, created: { [Op.gte]: cutoff }, ...scopeWhere(account) },
         raw: true,
      }) as unknown as EventRow[];

      const { forms, totalSubmissions } = buildFormSubmissions(rows);
      return res.status(200).json({ domain, period, forms, totalSubmissions, error: null });
   } catch (error) {
      console.log('[ERROR] Building Form Submissions for ', domain, error);
      return res.status(400).json({ error: 'Error Building Form Submissions for this Domain.' });
   }
};
