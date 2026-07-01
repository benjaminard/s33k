import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import { securityFacts, SecurityFacts } from '../../utils/securityFacts';

// SECURITY / TRUST FACTS: GET /api/security returns s33k's trust guarantees as structured,
// source-cited facts so a trial user's LLM can answer "is this safe? do you train on my data?
// who else can see it?" with a complete, verifiable answer. The MCP tool security_facts wraps
// this route. The single source for the content is utils/securityFacts.ts (SECURITY.md is the
// prose companion). This route reads nothing from the tenant's data: it returns the same facts
// for every caller. It is authed only so it travels the normal Bearer-key path (and is in the
// allowed-routes whitelist); the response contains no account data and no secrets.

type SecurityResponse = SecurityFacts | { error: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<SecurityResponse>) {
   await ensureSynced();
   const { authorized, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error: error ?? null });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return res.status(200).json(securityFacts);
}
