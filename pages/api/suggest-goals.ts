import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { crawlSite } from '../../utils/site-crawl';
import { suggestGoals, SuggestedGoal } from '../../utils/goal-suggester';

// GET /api/suggest-goals?domain=...
//
// Proposes ready-to-create conversion goals by crawling the site and spotting its likely
// conversions (thank-you / destination pages and intent / form pages). It SUGGESTS only; the
// user's LLM confirms and calls create_goal. Maximizing value with no UI: do not make the user
// invent their goals, hand them the obvious ones.

type Resp = { domain?: string, suggestions?: SuggestedGoal[], note?: string, error?: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getSuggestions(req, res, account);
}

const getSuggestions = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const crawl = await crawlSite(domain);
      const suggestions = suggestGoals(crawl.pages || []);
      const note = suggestions.length === 0
         ? 'No obvious conversion pages found in the crawl. You can still define a goal by hand with create_goal '
            + '(a thank-you page path, or form_submit on a page).'
         : `Found ${suggestions.length} likely conversion(s). Review and create the ones you want with create_goal.`;
      return res.status(200).json({ domain, suggestions, note, error: crawl.error || null });
   } catch (error) {
      console.log('[ERROR] Suggesting goals for ', domain, error);
      return res.status(400).json({ error: 'Error Suggesting Goals for this Domain.' });
   }
};
