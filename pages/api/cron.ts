import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
import { getAppSettings } from './settings';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import refreshAndUpdateKeywords from '../../utils/refresh';
import { failedRetryWhere } from '../../utils/scraper';

// Rank-refresh cron for the single-user install. Single-user: every keyword belongs to the one
// account, so there is no per-tenant scoping, no spend-brake (caps are unlimited), and no billing
// dunning. scopeWhere returns {}, so the sweep covers all of the user's own keywords.

type CRONRefreshRes = {
   started: boolean
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'POST') {
      // mode=retry is the hourly DB-backed retry job (replaces the old failed_queue.json file): it
      // re-scrapes ONLY keywords that currently have a real lastUpdateError. No mode (or mode=scrape)
      // is the normal full scrape cron. Both reuse the same Bearer auth. Any OTHER mode is rejected:
      // a stale caller must never fall through to the full scrape, because every accidental full
      // sweep spends real SERP credits (a leftover mode=dunning cron did exactly that, daily).
      const { mode } = req.query;
      if (mode === 'retry') {
         return cronRetryFailedKeywords(req, res, account);
      }
      if (mode === undefined || mode === 'scrape') {
         return cronRefreshkeywords(req, res, account);
      }
      return res.status(400).json({ started: false, error: `Unknown cron mode: ${String(mode)}` });
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

// CRON_PAGE_SIZE bounds how many keyword rows are claimed + held in memory per page of the sweep.
// Env-overridable; default 500. A single-user install (a handful of keywords) fits in one page.
const cronPageSize = (): number => {
   const raw = parseInt(process.env.CRON_PAGE_SIZE || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 500;
};

// In-process drain mutex. s33k runs as a single long-lived Node process, so a module-global boolean
// guards against two overlapping fires starting two concurrent drains that would double-charge the
// SERP provider for the same keywords. It resets on process restart, at which point no drain is in
// flight anyway; the next fire's stuck-row reset recovers any rows the dead drain left mid-flight.
let drainInFlight = false;

// Drain the full keyword set in bounded pages, stalest set first, each keyword claimed at most once
// per drain. Each page claims not-currently-updating, not-yet-seen keywords ordered stalest-first;
// EVERY claimed id is recorded in `seen` and excluded from later pages, so the cursor always advances
// and the loop ends when an empty page returns. Pages are AWAITED sequentially so concurrent SERP
// calls never exceed one page's SCRAPE_CONCURRENCY. Resumable: a crashed page leaves its rows
// updating:true, which the next drain's start-of-run reset clears so they scrape again.
const drainScrape = async (
   scope: Record<string, unknown>,
   settings: SettingsType,
   domainList: DomainType[],
): Promise<void> => {
   const pageSize = cronPageSize();
   const seen = new Set<number>();
   const maxPages = 10000;
   try {
      for (let page = 0; page < maxPages; page += 1) {
         const seenIds = Array.from(seen);
         const where: Record<string, unknown> = {
            ...scope,
            updating: false,
            ...(seenIds.length ? { ID: { [Op.notIn]: seenIds } } : {}),
         };
         const rows: Keyword[] = await Keyword.findAll({ where, order: [['lastUpdated', 'ASC'], ['ID', 'ASC']], limit: pageSize });
         if (rows.length === 0) { break; }
         rows.forEach((kw) => seen.add(kw.get('ID') as number));
         const keptIDs = rows.map((kw) => kw.get('ID') as number);
         await Keyword.update({ updating: true }, { where: { ID: keptIDs } });
         // Await each page before claiming the next so total in-flight SERP calls stay bounded by
         // one page's SCRAPE_CONCURRENCY rather than the whole table at once.
         await refreshAndUpdateKeywords(rows, settings, domainList);
      }
   } catch (error) {
      console.log('[ERROR] CRON drain scrape: ', error);
   } finally {
      drainInFlight = false;
   }
};

const cronRefreshkeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   // Claim the drain mutex synchronously (no await between the check and the set) so two near-
   // simultaneous fires cannot both pass the guard.
   if (drainInFlight) {
      return res.status(200).json({ started: true });
   }
   drainInFlight = true;
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         drainInFlight = false;
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = scopeWhere(account);
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      // Recover rows left updating:true by a drain that died mid-flight in a PRIOR run, so they are
      // eligible to scrape again (the resumability guarantee). Best-effort: a failure here must not
      // abort the sweep.
      try {
         await Keyword.update({ updating: false }, { where: { ...scope, updating: true } });
      } catch (resetErr) {
         console.log('[WARN] CRON stuck-updating reset failed (continuing): ', resetErr);
      }

      // Fire-and-forget the paged drain; return immediately so the request cannot time out.
      drainScrape(scope, settings, domainList);

      return res.status(200).json({ started: true });
   } catch (error) {
      drainInFlight = false;
      console.log('[ERROR] CRON Refreshing Keywords: ', error);
      return res.status(400).json({ started: false, error: 'CRON Error refreshing keywords!' });
   }
};

// The hourly DB-backed retry job (POST /api/cron?mode=retry): re-scrape ONLY keywords that currently
// have a real lastUpdateError and are not mid-scrape (failedRetryWhere). This replaces the old
// failed_queue.json file + /api/refresh?id=... path; the queue is now derived from the keyword rows.
const cronRetryFailedKeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = scopeWhere(account);
      const keywordQueries: Keyword[] = await Keyword.findAll({ where: { ...failedRetryWhere(), ...scope } });
      if (keywordQueries.length === 0) {
         return res.status(200).json({ started: true });
      }
      // Mark exactly the to-retry set updating, so the next retry tick does not double-fire them.
      const retryIDs = keywordQueries.map((kw) => kw.get('ID') as number);
      await Keyword.update({ updating: true }, { where: { ID: retryIDs } });
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      refreshAndUpdateKeywords(keywordQueries, settings, domainList);

      return res.status(200).json({ started: true });
   } catch (error) {
      console.log('[ERROR] CRON Retrying Failed Keywords: ', error);
      return res.status(400).json({ started: false, error: 'CRON Error retrying keywords!' });
   }
};
