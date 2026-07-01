import type { NextApiRequest, NextApiResponse } from 'next';
import verifyUser from '../../utils/verifyUser';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import { failedRetryWhere } from '../../utils/scraper';

// Clears the scraper retry queue. The queue is now DB-DERIVED (keywords whose lastUpdateError is a
// real error), not a data/failed_queue.json file, so "clearing" means resetting lastUpdateError to
// the no-error sentinel 'false' on every keyword that currently shows an error. This is a legacy
// instance-level admin maintenance route, so it stays on verifyUser rather than authorize(); when the
// retry queue becomes tenant-aware this should move to authorize() with owner-scoped clearing first.

type SettingsGetResponse = {
   cleared?: boolean,
   error?: string,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method === 'PUT') {
      return clearFailedQueue(req, res);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const clearFailedQueue = async (req: NextApiRequest, res: NextApiResponse<SettingsGetResponse>) => {
   try {
      await ensureSynced();
      // Reset only the keywords currently in the derived queue (a real lastUpdateError); a successful
      // clear leaves the no-error sentinel 'false', dropping them from the retry query.
      await Keyword.update({ lastUpdateError: 'false' }, { where: { ...failedRetryWhere() } });
      return res.status(200).json({ cleared: true });
   } catch (error) {
      console.log('[ERROR] Clearing Failed Queue.', error);
      // A13: the DB write failed, so the queue was NOT cleared. That is a server-side
      // failure, not a success, and must not report 200.
      return res.status(500).json({ error: 'Error Clearing Failed Queue!' });
   }
};
