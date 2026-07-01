import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import authorize from '../../../utils/authorize';
import resolveDomainAccess from '../../../utils/domain-access';
import { ownerIdFor } from '../../../utils/scope';
import type Account from '../../../database/models/account';
import {
   getGSCOAuthConfig,
   buildGSCRedirectURL,
   buildGSCOAuthClient,
   signGSCState,
   GSC_OAUTH_SCOPE,
} from '../../../utils/searchConsoleOAuth';

// GET /api/searchconsole/connect?domain=<d>
//
// Starts the click-to-authorize Google Search Console flow. Returns a Google consent URL the
// caller opens to grant s33k read-only Search Console access for a domain THEY OWN. Connecting a
// domain is a WRITE operation (it attaches a credential), so it is owner-gated via
// resolveDomainAccess(account, domain, { write: true }); a shared viewer or foreign tenant gets a
// 403. The returned `authUrl` carries a signed `state` that binds the flow to this owned domain +
// owner; the callback re-verifies that signature, because the callback itself runs without an API
// key or cookie (Google's redirect carries neither).

type connectRes = {
   authUrl?: string,
   instructions?: string,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<connectRes>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed.' });
   }
   return startConnect(req, res, account);
}

const startConnect = async (req: NextApiRequest, res: NextApiResponse<connectRes>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Missing.' });
   }
   // Resolve by the CANONICAL domain only (slug-decode fallback removed, third adversarial review).
   // A scoped share key is GET-only and CAN reach this GET, so the prior slug-decode was a real escape
   // vector: it could turn "a-b.com" into the sibling "a.b.com" the owner also owns and start an OAuth
   // connect on it. resolveDomainAccess canonicalizes internally and registration stores canonical, so
   // the decode is dead code. Connecting attaches a credential, so it requires WRITE access. The signed
   // state binds to the RESOLVED row's canonical domain so the callback stores the credential correctly.
   const ownedDomain = await resolveDomainAccess(account, req.query.domain as string, { write: true });
   if (!ownedDomain) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }
   // Bind the rest of the flow (signed state, instructions) to the RESOLVED row's domain.
   const domainname = ownedDomain.domain;

   // If the operator never set up the OAuth app, fail friendly instead of building a broken client.
   const config = getGSCOAuthConfig();
   if (!config) {
      return res.status(200).json({
         error: 'GSC OAuth is not configured on this instance. Set GSC_OAUTH_CLIENT_ID and '
            + 'GSC_OAUTH_CLIENT_SECRET, or connect Search Console with a service account instead.',
      });
   }

   try {
      const redirectURL = buildGSCRedirectURL(req);
      const oAuth2Client = buildGSCOAuthClient(config, redirectURL);
      // Sign a compact state binding this consent round trip to the verified owned domain + owner.
      // access_type 'offline' + prompt 'consent' force Google to return a refresh_token every time,
      // which is the long-lived credential we store (an access token alone would expire in an hour).
      const state = signGSCState({ domain: domainname, ownerId: ownerIdFor(account) });
      const authUrl = oAuth2Client.generateAuthUrl({
         access_type: 'offline',
         prompt: 'consent',
         scope: [GSC_OAUTH_SCOPE],
         state,
      });
      const instructions = `Open this link to connect Google Search Console for ${domainname}, approve `
         + 'read-only access, then come back. The connection is stored against this domain only.';
      return res.status(200).json({ authUrl, instructions });
   } catch (err) {
      console.log('[ERROR] Starting Search Console OAuth for: ', domainname, err);
      return res.status(400).json({ error: 'Failed to start Google Search Console connection. Please try again.' });
   }
};
