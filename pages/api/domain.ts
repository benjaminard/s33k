import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import type Account from '../../database/models/account';

type DomainGetResponse = {
   domain?: DomainType | null
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const { authorized, account, error } = await authorize(req, res);
   if (authorized && req.method === 'GET') {
      await ensureSynced();
      return getDomain(req, res, account);
   }
   return res.status(401).json({ error: error || 'Not authorized' });
}

const getDomain = async (req: NextApiRequest, res: NextApiResponse<DomainGetResponse>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') {
       return res.status(400).json({ error: 'Domain Name is Required!' });
   }

   try {
      // Look up by the canonical domain, matching how every Domain row is now stored, so a UI caller
      // passing a "www."/uppercase/trailing-dot variant still resolves its own row. canonicalizeDomain
      // is identity-preserving (no slug-decode).
      const query = { domain: canonicalizeDomain(req.query.domain), ...scopeWhere(account) };
      const foundDomain:Domain| null = await Domain.findOne({ where: query });
      const parsedDomain = foundDomain?.get({ plain: true }) || false;

      if (parsedDomain && parsedDomain.search_console) {
         try {
            // SECURITY (audit area 3, MEDIUM): never return the decrypted GSC service-account
            // private_key / client_email (or the encrypted oauth_refresh_token) to the client. The
            // UI only needs to know WHETHER GSC is configured, not the secret values. Mask each to a
            // boolean string exactly as domains.ts does, so this read path matches every other one
            // (domains.ts / export.ts) and a stolen admin cookie cannot exfiltrate the private key.
            const scData = JSON.parse(parsedDomain.search_console);
            const masked = {
               ...scData,
               client_email: scData.client_email ? 'true' : '',
               private_key: scData.private_key ? 'true' : '',
               oauth_refresh_token: scData.oauth_refresh_token ? 'true' : '',
            };
            parsedDomain.search_console = JSON.stringify(masked);
         } catch (error) {
            console.log('[Error] Parsing Search Console Keys.');
         }
      }

      return res.status(200).json({ domain: parsedDomain });
   } catch (error) {
      console.log('[ERROR] Getting Domain: ', error);
      return res.status(400).json({ error: 'Error Loading Domain' });
   }
};
