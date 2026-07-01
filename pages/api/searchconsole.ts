import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import {
   fetchDomainSCData,
   getSearchConsoleApiInfo,
   readLocalSCData,
   hasSearchConsoleCredentials,
   getSearchConsoleConnectionStatus,
   clearSearchConsoleOAuthToken,
   SCConnectionStatus,
} from '../../utils/searchConsole';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';

type searchConsoleRes = {
   data: SCDomainDataType|null
   status?: SCConnectionStatus,
   error?: string|null,
}

type searchConsoleCRONRes = {
   status: string,
   error?: string|null,
}

type searchConsoleDisconnectRes = {
   disconnected: boolean,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomainSearchConsoleData(req, res, account);
   }
   if (req.method === 'POST') {
      return cronRefreshSearchConsoleData(req, res, account);
   }
   if (req.method === 'DELETE') {
      return disconnectSearchConsole(req, res, account);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const getDomainSearchConsoleData = async (req: NextApiRequest, res: NextApiResponse<searchConsoleRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') return res.status(400).json({ data: null, error: 'Domain is Missing.' });
   // Resolve access by the CANONICAL domain only. The legacy slug-decode fallback ("-" -> ".",
   // "_" -> "-") was removed (third adversarial review): resolveDomainAccess canonicalizes internally
   // and registration stores canonical, so the decode is dead code AND a latent escape vector (it
   // re-derived a different host after the share-key gate already checked canonical). resolveDomainAccess
   // is the per-domain chokepoint and also guards the local-SC-file read driven off the resolved row.
   const foundDomain: Domain | null = await resolveDomainAccess(account, req.query.domain as string);
   if (!foundDomain) {
      return res.status(403).json({ data: null, error: 'Domain not found for this account' });
   }
   const domainObj: DomainType = foundDomain.get({ plain: true });
   // Drive downstream SC-file reads/logs off the resolved row's domain, not the request string.
   const domainname = foundDomain.domain;
   // Surface connection state (oauth | service-account | null) alongside the data so a caller can
   // tell whether/how GSC is connected for this domain without ever seeing the credentials.
   const status = await getSearchConsoleConnectionStatus(domainObj);
   const localSCData = await readLocalSCData(domainname);
   if (localSCData && localSCData.thirtyDays && localSCData.thirtyDays.length) {
      return res.status(200).json({ data: localSCData, status });
   }
   try {
      const scDomainAPI = await getSearchConsoleApiInfo(domainObj);
      if (!hasSearchConsoleCredentials(scDomainAPI)) {
         return res.status(200).json({ data: null, status, error: 'Google Search Console is not Integrated.' });
      }
      const scData = await fetchDomainSCData(domainObj, scDomainAPI);
      return res.status(200).json({ data: scData, status });
   } catch (error) {
      console.log('[ERROR] Getting Search Console Data for: ', domainname, error);
      return res.status(400).json({ data: null, status, error: 'Error Fetching Data from Google Search Console.' });
   }
};

// DELETE /api/searchconsole?domain=<d>. Owner-gated disconnect: clears the click-to-authorize OAuth
// refresh token for the domain (service-account credentials, if any, stay as the fallback). Requires
// WRITE access to the domain, so a shared viewer (M2) or a foreign tenant can never disconnect it.
const disconnectSearchConsole = async (req: NextApiRequest, res: NextApiResponse<searchConsoleDisconnectRes>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') return res.status(400).json({ disconnected: false, error: 'Domain is Missing.' });
   // Resolve by the canonical domain only (slug-decode fallback removed, third adversarial review).
   // resolveDomainAccess canonicalizes internally and clears the token off the RESOLVED row's actual
   // domain, so a raw variant can never reach a sibling. (Scoped share keys are GET-only and never
   // reach this DELETE, but the write path still must not re-derive a different host past its gate.)
   const ownedDomain = await resolveDomainAccess(account, req.query.domain as string, { write: true });
   if (!ownedDomain) {
      return res.status(403).json({ disconnected: false, error: 'Domain not found for this account' });
   }
   const domainname = ownedDomain.domain;
   // Scope the clear to the exact owned row (its globally-unique domain name plus the owner scope),
   // so the write can only ever touch the caller's own domain.
   const cleared = await clearSearchConsoleOAuthToken({ domain: domainname, ...scopeWhere(account) });
   if (!cleared) {
      return res.status(400).json({ disconnected: false, error: 'Failed to disconnect Google Search Console.' });
   }
   return res.status(200).json({ disconnected: true });
};

const cronRefreshSearchConsoleData = async (req: NextApiRequest, res: NextApiResponse<searchConsoleCRONRes>, account?: Account | null) => {
   try {
      const allDomainsRaw = await Domain.findAll({ where: { ...scopeWhere(account) } });
      const Domains: DomainType[] = allDomainsRaw.map((el) => el.get({ plain: true }));
      for (const domain of Domains) {
         const scDomainAPI = await getSearchConsoleApiInfo(domain);
         if (scDomainAPI.client_email && scDomainAPI.private_key) {
            await fetchDomainSCData(domain, scDomainAPI);
         }
      }
      return res.status(200).json({ status: 'completed' });
   } catch (error) {
      console.log('[ERROR] CRON Updating Search Console Data. ', error);
      return res.status(400).json({ status: 'failed', error: 'Error Fetching Data from Google Search Console.' });
   }
};
