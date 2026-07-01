import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import Cryptr from 'cryptr';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import getdomainStats from '../../utils/domains';
import authorize from '../../utils/authorize';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import resolveDomainAccess from '../../utils/domain-access';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import type Account from '../../database/models/account';
import { checkSerchConsoleIntegration, removeLocalSCData } from '../../utils/searchConsole';
import { removeFromRetryQueue } from '../../utils/scraper';
import { rateLimit } from '../../utils/rate-limit';

type DomainsGetRes = {
   domains: DomainType[]
   error?: string|null,
}

type DomainsAddResponse = {
   domains: DomainType[]|null,
   error?: string|null,
}

type DomainsDeleteRes = {
   domainRemoved: number,
   keywordsRemoved: number,
   SCDataRemoved: boolean,
   error?: string|null,
}

type DomainsUpdateRes = {
   domain: Domain|null,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomains(req, res, account);
   }
   if (req.method === 'POST') {
      return addDomain(req, res, account);
   }
   if (req.method === 'DELETE') {
      return deleteDomain(req, res, account);
   }
   if (req.method === 'PUT') {
      return updateDomain(req, res, account);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

export const getDomains = async (req: NextApiRequest, res: NextApiResponse<DomainsGetRes>, account?: Account | null) => {
   const withStats = !!req?.query?.withstats;
   try {
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scopeWhere(account) } });
      const formattedDomains: DomainType[] = allDomains.map((el): DomainType => {
         const domainItem = el.get({ plain: true }) as Record<string, unknown>;
         // FIELD HYGIENE for the customer surface (the same response the UI and the hosted MCP read):
         //   1. Never emit credential-shaped fields. The raw Search Console blob carries cryptr-
         //      encrypted client_email / private_key (and an oauth_refresh_token); we strip ALL of them
         //      and expose only a `searchConsoleConnected` boolean plus the non-secret config the SC
         //      settings modal needs to prefill (property_type, url). A consumer should never see a
         //      key-shaped value here, even an encrypted one.
         //   2. Expose a neutral `siteId` for the beacon. The first-party beacon keys every event by
         //      domain, so the site id IS the domain; the vestigial `umami_website_id` column is
         //      dropped from the response.
         const rawSC = typeof domainItem.search_console === 'string' ? domainItem.search_console : '';
         const scData = rawSC ? JSON.parse(rawSC) : {};
         const searchConsoleConnected = !!(scData?.client_email && scData?.private_key) || !!scData?.oauth_refresh_token;
         const safeSearchConsole = { property_type: scData?.property_type || 'domain', url: scData?.url || '' };
         const { search_console, umami_website_id, ...rest } = domainItem;
         return {
            ...(rest as unknown as DomainType),
            siteId: typeof rest.domain === 'string' ? rest.domain : null,
            searchConsoleConnected,
            search_console: JSON.stringify(safeSearchConsole),
         };
      });
      const theDomains: DomainType[] = withStats ? await getdomainStats(formattedDomains) : formattedDomains;
      return res.status(200).json({ domains: theDomains });
   } catch (error) {
      return res.status(400).json({ domains: [], error: 'Error Getting Domains.' });
   }
};

const addDomain = async (req: NextApiRequest, res: NextApiResponse<DomainsAddResponse>, account?: Account | null) => {
   const { domains } = req.body;
   if (domains && Array.isArray(domains) && domains.length > 0) {
      // PER-KEY WRITE BRAKE: bound how fast one account/key can create sites, so a leaked or runaway
      // key cannot fan out unbounded site creation (each new site queues cost-bearing work downstream).
      // Keyed on the resolved account id (the admin sentinel under MULTI_TENANT off shares one key,
      // which is fine: it is the single operator). Mirrors the onboard / hosted-MCP rate brake.
      const brake = rateLimit(`write:${ownerIdFor(account) ?? 'admin'}`, { limit: 60, windowMs: 60000 });
      if (!brake.allowed) {
         res.setHeader('Retry-After', Math.ceil(brake.retryAfterMs / 1000));
         return res.status(429).json({ domains: null, error: 'Too many requests. Please slow down and retry shortly.' });
      }
      const owner_id = ownerIdFor(account);

      // Store the CANONICAL domain form, never the raw trimmed string (third adversarial review).
      // The cross-tenant leak existed because two canonical-equal names ("example.com" and
      // "example.com." / "www.example.com") could coexist as separate rows under DIFFERENT
      // owners (the @Unique index is on raw bytes). A scoped share key for one could then resolve
      // the sibling. Canonicalizing at write time means a canonical-colliding variant can never be
      // stored as a second row, so a canonical name belongs to exactly one account. We also reject
      // any input that canonicalizes to empty, and dedupe within the same request batch.
      const domainsToAdd: any = [];
      const seenCanonical = new Set<string>();
      for (const domain of domains as string[]) {
         const canonical = canonicalizeDomain(domain);
         if (!canonical) {
            return res.status(400).json({ domains: [], error: 'A submitted domain is not valid.' });
         }
         // Skip an in-request duplicate (same canonical twice in one batch) rather than inserting it.
         if (!seenCanonical.has(canonical)) {
            seenCanonical.add(canonical);
            domainsToAdd.push({
               domain: canonical,
               slug: canonical.replaceAll('-', '_').replaceAll('.', '-').replaceAll('/', '-'),
               lastUpdated: new Date().toJSON(),
               added: new Date().toJSON(),
               owner_id,
            });
         }
      }

      // Duplicate check on the CANONICAL form. Registering a canonical-equal variant of an existing
      // domain (whether the caller's own or, in a multi-tenant world, anyone's, since the column is
      // globally @Unique) is rejected as a duplicate rather than attempted as a second insert. This
      // makes the intent explicit and returns a clean 400 instead of a generic unique-constraint 400.
      const existing = await Domain.findAll({ where: { domain: { [Op.in]: Array.from(seenCanonical) } } });
      if (existing.length > 0) {
         const dupes = existing.map((d) => d.domain).join(', ');
         return res.status(400).json({ domains: [], error: `Domain already exists: ${dupes}` });
      }

      try {
         const newDomains:Domain[] = await Domain.bulkCreate(domainsToAdd);
         const formattedDomains = newDomains.map((el) => el.get({ plain: true }));
         return res.status(201).json({ domains: formattedDomains });
      } catch (error) {
         console.log('[ERROR] Adding New Domain ', error);
         return res.status(400).json({ domains: [], error: 'Error Adding Domain.' });
      }
   } else {
      return res.status(400).json({ domains: [], error: 'Necessary data missing.' });
   }
};

export const deleteDomain = async (req: NextApiRequest, res: NextApiResponse<DomainsDeleteRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') {
      return res.status(400).json({ domainRemoved: 0, keywordsRemoved: 0, SCDataRemoved: false, error: 'Domain is Required!' });
   }
   try {
      const scope = scopeWhere(account);
      // OWNERSHIP GATE (security review #5): confirm the caller actually owns a domain row
      // BEFORE touching anything, so a tenant cannot delete another tenant's keywords or
      // its on-disk Search Console cache by passing the bare domain string. With
      // MULTI_TENANT off, scopeWhere is {} so this is the existing "does the domain exist"
      // check; with it on, it enforces owner_id.
      // Deleting a domain (and cascading its keywords + SC cache) is an owner-only mutation,
      // so use the WRITE gate. A shared read-only viewer (M2) can never delete the owner's domain.
      const owned = await resolveDomainAccess(account, req.query.domain as string, { write: true });
      if (!owned) {
         return res.status(404).json({ domainRemoved: 0, keywordsRemoved: 0, SCDataRemoved: false, error: 'Domain not found for this account' });
      }
      // Drive every cascade off the RESOLVED row's canonical domain, never the raw req.query.domain.
      // resolveDomainAccess looks up by the canonical form, so a raw variant ("example.com.") that
      // passes the gate must not then be used as the destroy key (it would match nothing and orphan
      // the row's keywords). Using owned.domain keeps the gate and the mutation on one canonical string.
      const { domain } = owned;
      await Promise.all((await Keyword.findAll({ where: { domain, ...scope } })).map((keyword) => removeFromRetryQueue(keyword.ID)));
      const removedDomCount: number = await Domain.destroy({ where: { domain, ...scope } });
      const removedKeywordCount: number = await Keyword.destroy({ where: { domain, ...scope } });
      // Only clear the local Search Console cache once a scoped domain was actually removed.
      const SCDataRemoved = removedDomCount > 0 ? await removeLocalSCData(domain) : false;

      return res.status(200).json({ domainRemoved: removedDomCount, keywordsRemoved: removedKeywordCount, SCDataRemoved });
   } catch (error) {
      console.log('[ERROR] Deleting Domain: ', req.query.domain, error);
      return res.status(400).json({ domainRemoved: 0, keywordsRemoved: 0, SCDataRemoved: false, error: 'Error Deleting Domain' });
   }
};

export const updateDomain = async (req: NextApiRequest, res: NextApiResponse<DomainsUpdateRes>, account?: Account | null) => {
   if (!req.query.domain) {
      return res.status(400).json({ domain: null, error: 'Domain is Required!' });
   }
   const { domain } = req.query || {};
   const {
      notification_interval, notification_emails, search_console,
      scrape_strategy, scrape_pagination_limit, scrape_smart_full_fallback,
      subdomain_matching,
   } = req.body as DomainSettings;

   try {
      // Updating a domain's settings is owner-only, so use the WRITE gate (shared viewers, M2,
      // cannot change another account's domain configuration).
      const domainToUpdate: Domain|null = await resolveDomainAccess(account, domain as string, { write: true });
      // Validate Search Console API Data
      if (domainToUpdate && search_console?.client_email && search_console?.private_key) {
         const theDomainObj = domainToUpdate.get({ plain: true });
         const isSearchConsoleAPIValid = await checkSerchConsoleIntegration({ ...theDomainObj, search_console: JSON.stringify(search_console) });
         if (!isSearchConsoleAPIValid.isValid) {
            return res.status(400).json({ domain: null, error: isSearchConsoleAPIValid.error });
         }
         const cryptr = new Cryptr(process.env.SECRET as string);
         search_console.client_email = search_console.client_email ? cryptr.encrypt(search_console.client_email.trim()) : '';
         search_console.private_key = search_console.private_key ? cryptr.encrypt(search_console.private_key.trim()) : '';
      }
      if (domainToUpdate) {
         domainToUpdate.set({
            notification_interval,
            notification_emails,
            search_console: JSON.stringify(search_console),
            scrape_strategy: scrape_strategy || '',
            scrape_pagination_limit: scrape_pagination_limit || 0,
            scrape_smart_full_fallback: !!scrape_smart_full_fallback,
            subdomain_matching: subdomain_matching || '',
         });
         await domainToUpdate.save();
      }
      return res.status(200).json({ domain: domainToUpdate });
   } catch (error) {
      console.log('[ERROR] Updating Domain: ', req.query.domain, error);
      return res.status(400).json({ domain: null, error: 'Error Updating Domain. An Unknown Error Occurred.' });
   }
};
