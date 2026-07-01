import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import type Account from '../../database/models/account';
import { findCannibalization, CannibalInput, CannibalGroup } from '../../utils/cannibalization';

// GET /api/cannibalization?domain=
//
// Find keyword cannibalization: the cases where Google cannot decide which of your pages should rank
// for a term, so the pages compete and split the equity instead of one ranking well. Pure join over
// tracked Keyword rows. Conservative on purpose (only clear cases), since false positives waste time.
// Flags three signals: (a) intent split (a keyword ranks on a url that is not its target_page), (b)
// shared ranking url (distinct keywords ranking on the same url but targeting different pages), and
// (c) near-duplicate terms ranking on different urls. No LLM: returns structured groups for the
// user's own LLM (and the briefing) to narrate.

type Resp = {
   domain?: string,
   total?: number,
   groups?: CannibalGroup[],
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getCannibalization(req, res, account);
}

const getCannibalization = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   // Ownership gate first: the domain column is globally unique, so by-domain scoping cannot leak
   // across tenants. 403 before reading any keyword data.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const keywordRows = await Keyword.findAll({
         where: { domain, ...scopeWhere(account) },
         attributes: ['keyword', 'position', 'url', 'target_page'],
      });
      const keywords: CannibalInput[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return {
            keyword: String(p.keyword || ''),
            position: Number(p.position) || 0,
            url: String(p.url || ''),
            target_page: String(p.target_page || ''),
         };
      });

      const groups = findCannibalization(keywords);
      const note = groups.length === 0
         ? 'No clear keyword cannibalization found. Every ranked keyword lands on its target page and no two '
            + 'pages are competing for the same term. (Detection is conservative, so only clear conflicts surface.)'
         : `${groups.length} cannibalization conflict(s) found, where Google is torn between your own pages for a term. `
            + 'Consolidate (merge, redirect, or de-target one page) so a single page owns each intent and ranks better.';

      return res.status(200).json({
         domain,
         total: groups.length,
         groups,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Cannibalization for ', domain, error);
      return res.status(400).json({ error: 'Error Building Cannibalization for this Domain.' });
   }
};
