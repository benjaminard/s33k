import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import authorize from '../../utils/authorize';
import { scopeWhere, ADMIN_ACCOUNT_ID } from '../../utils/scope';
import type Account from '../../database/models/account';

// DATA EXPORT: ownership the caller can exercise. GET /api/export returns EVERYTHING s33k holds
// as one JSON bundle: domains, keywords (with full rank history), and autocapture events. This is
// the human-and-machine-readable proof of "your data is yours and you can take it with you."
//
// SINGLE-USER: scopeWhere returns {} and the caller is the single admin account, so the export is
// simply all data.
//
// NO SECRETS EVER LEAVE: this endpoint never emits a secret. Search Console / Google Ads
// credentials on a domain are cryptr-encrypted at rest (see utils/searchConsole.ts); we strip them
// to booleans ("present" / not) here.

type ExportResponse = {
   exportedAt?: string,
   accountId?: number | null,
   domains?: Record<string, unknown>[],
   keywords?: Record<string, unknown>[],
   events?: Record<string, unknown>[],
   counts?: Record<string, number>,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<ExportResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return exportData(req, res, account);
}

// Strip the encrypted Search Console blob on a domain down to booleans so we never emit a
// secret. We report only WHETHER credentials are configured, never their (encrypted) value.
const sanitizeDomain = (domain: Domain): Record<string, unknown> => {
   const plain = domain.get({ plain: true }) as Record<string, unknown>;
   let hasSearchConsole = false;
   const sc = plain.search_console;
   if (sc && typeof sc === 'string') {
      try {
         const parsed = JSON.parse(sc);
         hasSearchConsole = Boolean(parsed?.client_email && parsed?.private_key);
      } catch { hasSearchConsole = false; }
   }
   delete plain.search_console;
   return { ...plain, search_console_configured: hasSearchConsole };
};

const exportData = async (req: NextApiRequest, res: NextApiResponse<ExportResponse>, account?: Account | null) => {
   try {
      const scope = scopeWhere(account);

      // 1. Domains.
      const domains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainNames = domains.map((d) => d.domain);

      // 2. Keywords: restricted to the caller's domain set.
      const keywordWhere = domainNames.length > 0
         ? { ...scope, domain: { [Op.in]: domainNames } }
         : { ...scope, domain: { [Op.in]: [] as string[] } };
      const keywords: Keyword[] = await Keyword.findAll({ where: keywordWhere });

      // 3. Autocapture events: restricted to the caller's domain set.
      const eventWhere = domainNames.length > 0
         ? { ...scope, domain: { [Op.in]: domainNames } }
         : { ...scope, domain: { [Op.in]: [] as string[] } };
      const events: S33kEvent[] = await S33kEvent.findAll({ where: eventWhere });

      const domainsOut = domains.map(sanitizeDomain);
      const keywordsOut = keywords.map((k) => k.get({ plain: true }) as Record<string, unknown>);
      const eventsOut = events.map((e) => e.get({ plain: true }) as Record<string, unknown>);

      return res.status(200).json({
         exportedAt: new Date().toJSON(),
         accountId: account?.ID ?? ADMIN_ACCOUNT_ID,
         domains: domainsOut,
         keywords: keywordsOut,
         events: eventsOut,
         counts: {
            domains: domainsOut.length,
            keywords: keywordsOut.length,
            events: eventsOut.length,
         },
      });
   } catch (error) {
      console.log('[ERROR] Exporting account data: ', error);
      return res.status(400).json({ error: 'Error Exporting Account Data.' });
   }
};
