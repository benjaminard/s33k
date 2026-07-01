import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';

// /api/me returns the calling account as resolved by authorize(). Single-user: every authorized
// caller is the one admin account, which is the correct and only answer.

type MeRes = {
   account?: { ID: number, name: string, plan: string, status: string } | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<MeRes>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed.' });
   }
   // The caller resolves to the bare in-memory admin sentinel ({ ID }); fall back to the admin
   // defaults so the response shape stays stable.
   return res.status(200).json({
      account: {
         ID: account.ID,
         name: account.name ?? 'Admin',
         plan: account.plan ?? 'admin',
         status: account.status ?? 'active',
      },
   });
}
