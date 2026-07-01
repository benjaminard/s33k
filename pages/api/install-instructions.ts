/**
 * On-demand install instructions for a domain's tracking code.
 *
 * Returns the s33k.js beacon snippet and per-platform install guides (raw HTML, Google Tag
 * Manager, WordPress, Webflow, Shopify, Squarespace, Wix, Next.js/React) for an already
 * onboarded domain, without re-running the whole onboard flow.
 *
 * Single-user first-party beacon: the beacon's data-website-id is just the domain itself.
 * Every s33k_event row is keyed by `domain`, and the analytics provider queries by domain,
 * so there is no external analytics site id to provision or resolve.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import type Account from '../../database/models/account';
import { getInstallGuides, InstallGuides } from '../../utils/install-guides';

type InstallInstructionsResponse = {
   domain?: string,
   siteId?: string | null,
   installSnippet?: string,
   installGuides?: InstallGuides,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<InstallInstructionsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getInstructions(req, res, account);
}

const getInstructions = async (
   req: NextApiRequest,
   res: NextApiResponse<InstallInstructionsResponse>,
   account?: Account | null,
) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   // Use the shared canonicalizer so this route's lookup matches the authorize() share-key gate
   // EXACTLY. Previously this route canonicalized inline (lowercase / strip protocol / www / path)
   // while the gate compared the raw param, so a non-canonical scoped_domain could pass the gate
   // and then resolve to a different (canonicalized) domain. Canonicalizing both sides the same way
   // closes that mismatch. canonicalizeDomain is identity-preserving (no slug-decode), so it never
   // turns "a-b.com" into "a.b.com".
   const domain = canonicalizeDomain(req.query.domain);

   try {
      // Verify the caller owns the domain before exposing its install details.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }
      // The first-party beacon keys every event by domain, so the domain IS the site id.
      const siteId = domain;
      const installGuides = getInstallGuides(domain, siteId);
      return res.status(200).json({
         domain,
         siteId,
         installSnippet: installGuides.snippet,
         installGuides,
      });
   } catch (error) {
      console.log('[ERROR] Getting install instructions for ', domain, error);
      return res.status(400).json({ error: 'Error getting install instructions for this domain.' });
   }
};
