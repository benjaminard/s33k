/**
 * HELP / SELF-SUPPORT: GET /api/help?topic=&q= returns the relevant slice of s33k's single
 * product-knowledge source (utils/knowledge.ts) so a user can ask their own LLM ANY question
 * about s33k (what a capability does, how to set up tracking, why a design decision was made,
 * how to troubleshoot, whether it is safe, pricing/limits) and get an honest, specific answer.
 *
 * The MCP tool `help` wraps this route. This is what makes s33k self-supporting: the answers
 * to "how do I..." and "what does X do" come from one authoritative layer, exposed over MCP.
 *
 * Like GET /api/security, this route reads NOTHING from the tenant's data: it returns the same
 * knowledge for every caller. It is authed only so it travels the normal Bearer-key path (and
 * is in the allowed-routes whitelist); the response contains no account data and no secrets.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import { searchKnowledge } from '../../utils/knowledge';

type HelpResponse = ReturnType<typeof searchKnowledge> | { error: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<HelpResponse>) {
   await ensureSynced();
   const { authorized, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error: error ?? null });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   const q = typeof req.query.q === 'string' ? req.query.q : '';
   const topic = typeof req.query.topic === 'string' ? req.query.topic : '';
   return res.status(200).json(searchKnowledge(q, topic));
}
