import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
import { getAppSettings } from './settings';
import authorize from '../../utils/authorize';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import { MAX_KEYWORDS_PER_REQUEST, MAX_KEYWORDS_PER_DOMAIN } from '../../utils/limits';
import { reserveKeywordSlots, CapExceeded } from '../../utils/caps-guard';
import { rateLimit } from '../../utils/rate-limit';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { compactKeywordResponse, CompactKeyword } from '../../utils/serp-compact';
import { integrateKeywordSCData, readLocalSCData } from '../../utils/searchConsole';
import refreshAndUpdateKeywords from '../../utils/refresh';
import { getKeywordsVolume, updateKeywordsVolumeData } from '../../utils/adwords';
import { removeFromRetryQueue } from '../../utils/scraper';

type KeywordsGetResponse = {
   // GET returns full KeywordType rows (with lastResult emptied); the WRITE responses (POST/PUT)
   // return CompactKeyword rows, where the lastResult echo is replaced by serpTop + serpResultCount.
   keywords?: KeywordType[] | CompactKeyword[],
   error?: string|null,
}

type KeywordsDeleteRes = {
   domainRemoved?: number,
   keywordsRemoved?: number,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }

   if (req.method === 'GET') {
      return getKeywords(req, res, account);
   }
   if (req.method === 'POST') {
      return addKeywords(req, res, account);
   }
   if (req.method === 'DELETE') {
      return deleteKeywords(req, res, account);
   }
   if (req.method === 'PUT') {
      return updateKeywords(req, res, account);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const getKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsGetResponse>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const settings = await getAppSettings();
   // Query by the CANONICAL domain, not the raw query param. authorize() gates a scoped share key on
   // the canonical form and registration stores the canonical form, so reading the raw param would
   // diverge (a non-canonical variant would match no row). scopeWhere(account) still scopes the read
   // to the caller's account, so this stays leak-safe; canonicalizing just removes the raw-vs-canonical
   // mismatch and keeps this read consistent with the gate and with domains.ts / share.ts.
   const domain = canonicalizeDomain(req.query.domain as string);
   const integratedSC = process.env.SEARCH_CONSOLE_PRIVATE_KEY && process.env.SEARCH_CONSOLE_CLIENT_EMAIL;
   const { search_console_client_email, search_console_private_key } = settings;
   const domainSCData = integratedSC || (search_console_client_email && search_console_private_key) ? await readLocalSCData(domain) : false;

   try {
      const allKeywords:Keyword[] = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
      const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));
      const processedKeywords = keywords.map((keyword) => {
         const historyArray = Object.keys(keyword.history).map((dateKey:string) => ({
            date: new Date(dateKey).getTime(),
            dateRaw: dateKey,
            position: keyword.history[dateKey],
         }));
         const historySorted = historyArray.sort((a, b) => a.date - b.date);
         const lastWeekHistory :KeywordHistory = {};
         historySorted.slice(-7).forEach((x:any) => { lastWeekHistory[x.dateRaw] = x.position; });
         const keywordWithSlimHistory = { ...keyword, lastResult: [], history: lastWeekHistory };
         const finalKeyword = domainSCData ? integrateKeywordSCData(keywordWithSlimHistory, domainSCData) : keywordWithSlimHistory;
         return finalKeyword;
      });
      return res.status(200).json({ keywords: processedKeywords });
   } catch (error) {
      console.log('[ERROR] Getting Domain Keywords for ', domain, error);
      return res.status(400).json({ error: 'Error Loading Keywords for this Domain.' });
   }
};

const addKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsGetResponse>, account?: Account | null) => {
   const { keywords } = req.body;
   if (keywords && Array.isArray(keywords) && keywords.length > 0) {
      // PER-KEY WRITE BRAKE: bound how fast one account/key can create keywords, so a leaked or
      // runaway key cannot fan out unbounded cost-bearing SERP scrapes. Keyed on the resolved account
      // id (the admin sentinel under MULTI_TENANT off shares one key, which is fine: single operator).
      // Mirrors the addDomain / onboard / hosted-MCP rate brake. Runs before the per-request cap so a
      // flood takes the cheaper rejection.
      const brake = rateLimit(`write:${ownerIdFor(account) ?? 'admin'}`, { limit: 60, windowMs: 60000 });
      if (!brake.allowed) {
         res.setHeader('Retry-After', Math.ceil(brake.retryAfterMs / 1000));
         return res.status(429).json({ error: 'Too many requests. Please slow down and retry shortly.' });
      }
      // Per-request cap. Bounds one bulk insert and the scrape burst it queues.
      if (keywords.length > MAX_KEYWORDS_PER_REQUEST) {
         return res.status(400).json({ error: `Too many keywords in one request (max ${MAX_KEYWORDS_PER_REQUEST}).` });
      }
      // Every keyword must name a domain.
      if (keywords.some((k: KeywordAddPayload) => !k || typeof k.domain !== 'string' || !k.domain.trim())) {
         return res.status(400).json({ error: 'Every keyword must include a domain.' });
      }
      // A schema-documented argument must either work or be rejected, never silently drop: a
      // non-string target_page would previously coerce/garble on insert while the caller assumed it
      // stored. Reject it loudly instead (same contract as the PUT path below).
      if (keywords.some((k: KeywordAddPayload) => k.target_page !== undefined && typeof k.target_page !== 'string')) {
         return res.status(400).json({ error: 'target_page must be a string when provided.' });
      }

      // OWNERSHIP GATE (security review #2): the caller must OWN every domain they add
      // keywords for, before any cost-bearing bulkCreate + scrape. scopeWhere is {} when
      // MULTI_TENANT is off (so this just requires the domain to exist, which is correct),
      // and enforces owner_id when on (so a tenant cannot add keywords against another
      // tenant's domain string, burn the operator's SERP quota, or skew their stats).
      // Canonicalize every requested domain so the ownership check, the per-domain cap, and the
      // stored keyword.domain all key off the ONE canonical form Domain rows are registered under
      // (third adversarial review). Without this, a keyword payload for "www.example.com" would miss
      // the owned "example.com" row (wrongly rejected) or, if it slipped through, store a keyword
      // under a non-canonical domain that never joins back to its Domain row.
      const requestedDomains = Array.from(new Set(keywords.map((k: KeywordAddPayload) => canonicalizeDomain(k.domain))));
      if (requestedDomains.some((d) => !d)) {
         return res.status(400).json({ error: 'A keyword names an invalid domain.' });
      }
      const ownedDomains = await Domain.findAll({ where: { domain: { [Op.in]: requestedDomains }, ...scopeWhere(account) } });
      const ownedDomainSet = new Set(ownedDomains.map((d) => d.domain));
      const unowned = requestedDomains.filter((d) => !ownedDomainSet.has(d));
      if (unowned.length > 0) {
         return res.status(403).json({ error: `Domain not found for this account: ${unowned.join(', ')}` });
      }

      // PER-DOMAIN CAP (security review #2 / #6): the keyword-cap claim in the product's
      // own knowledge facts is enforced here. Count existing tracked keywords per domain
      // and reject if this request would push any domain over the cap.
      const newByDomain: Record<string, number> = {};
      for (const k of keywords as KeywordAddPayload[]) {
         const d = canonicalizeDomain(k.domain);
         newByDomain[d] = (newByDomain[d] || 0) + 1;
      }
      for (const domain of requestedDomains) {
         // eslint-disable-next-line no-await-in-loop
         const existing = await Keyword.count({ where: { domain, ...scopeWhere(account) } });
         if (existing + newByDomain[domain] > MAX_KEYWORDS_PER_DOMAIN) {
            return res.status(400).json({
               error: `Keyword cap reached for ${domain} (max ${MAX_KEYWORDS_PER_DOMAIN}; ${existing} already tracked).`,
            });
         }
      }

      // Single-user: caps are unlimited, so reserveKeywordSlots is a lock-free passthrough (it never
      // throws CapExceeded here). It is kept because it also owns the atomic bulkCreate path.
      const requestedCount = keywords.length;

      const keywordsToAdd: any = []; // QuickFIX for bug: https://github.com/sequelize/sequelize-typescript/issues/936
      const owner_id = ownerIdFor(account);
      // Dedupe within the request by the natural key, so a single call cannot insert (and
      // pay to scrape) the same keyword+device+country+domain twice.
      const seen = new Set<string>();

      keywords.forEach((kwrd: KeywordAddPayload) => {
         const { keyword, device, country, tags, city, target_page } = kwrd;
         // Store the keyword against the CANONICAL domain so it joins back to its Domain row and the
         // per-domain scoreboard, and dedupe on that same canonical key.
         const domain = canonicalizeDomain(kwrd.domain);
         const dedupeKey = `${(keyword || '').trim().toLowerCase()}|${device}|${country}|${domain}`;
         if (seen.has(dedupeKey)) { return; }
         seen.add(dedupeKey);
         const tagsArray = tags ? tags.split(',').map((item:string) => item.trim()) : [];
         const newKeyword = {
            keyword,
            device,
            domain,
            country,
            city,
            // Trimmed, exactly like the PUT path stores it, so a keyword created with target_page
            // joins page_scoreboard identically to one updated with it.
            target_page: typeof target_page === 'string' ? target_page.trim() : '',
            position: 0,
            updating: true,
            history: JSON.stringify({}),
            url: '',
            tags: JSON.stringify(tagsArray),
            sticky: false,
            lastUpdated: new Date().toJSON(),
            added: new Date().toJSON(),
            owner_id,
         };
         keywordsToAdd.push(newKeyword);
      });

      try {
         // reserveKeywordSlots runs the bulkCreate inside a transaction (createFn(t)). In single-user
         // mode caps are unlimited, so it never throws CapExceeded; the branch below is a safety net.
         const newKeywords:Keyword[] = await reserveKeywordSlots(account, requestedCount, (t) => (
            Keyword.bulkCreate(keywordsToAdd, t ? { transaction: t } : undefined)
         ));
         const formattedkeywords = newKeywords.map((el) => el.get({ plain: true }));
         const keywordsParsed: KeywordType[] = parseKeywords(formattedkeywords);

         // Queue the SERP Scraping Process
         const settings = await getAppSettings();
         refreshAndUpdateKeywords(newKeywords, settings);

         // Update the Keyword Volume
         const { adwords_account_id, adwords_client_id, adwords_client_secret, adwords_developer_token } = settings;
         if (adwords_account_id && adwords_client_id && adwords_client_secret && adwords_developer_token) {
            const keywordsVolumeData = await getKeywordsVolume(keywordsParsed);
            if (keywordsVolumeData.volumes !== false) {
               await updateKeywordsVolumeData(keywordsVolumeData.volumes);
            }
         }

         // Write responses are compact: replace the lastResult echo ([] on create) with
         // serpTop + serpResultCount, matching the PUT response shape.
         return res.status(201).json({ keywords: keywordsParsed.map(compactKeywordResponse) });
      } catch (error) {
         // Safety net: caps are unlimited in single-user mode, so this should not fire.
         if (error instanceof CapExceeded) {
            return res.status(403).json({ error: `Keyword limit reached (${error.limit}; ${error.existing} in use).` });
         }
         console.log('[ERROR] Adding New Keywords ', error);
         return res.status(400).json({ error: 'Could Not Add New Keyword!' });
      }
   } else {
      return res.status(400).json({ error: 'Necessary Keyword Data Missing' });
   }
};

const deleteKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsDeleteRes>, account?: Account | null) => {
   if (!req.query.id && typeof req.query.id !== 'string') {
      return res.status(400).json({ error: 'keyword ID is Required!' });
   }
   console.log('req.query.id: ', req.query.id);

   try {
      const keywordsToRemove = (req.query.id as string).split(',').map((item) => parseInt(item, 10));
      const removeQuery = { where: { ID: { [Op.in]: keywordsToRemove }, ...scopeWhere(account) } };
      const removedKeywordCount: number = await Keyword.destroy(removeQuery);

      // remove keyword from retry queue if exists
      await Promise.all(keywordsToRemove.map((keywordID) => removeFromRetryQueue(keywordID)));

      return res.status(200).json({ keywordsRemoved: removedKeywordCount });
   } catch (error) {
      console.log('[ERROR] Removing Keyword. ', error);
      return res.status(400).json({ error: 'Could Not Remove Keyword!' });
   }
};

const updateKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsGetResponse>, account?: Account | null) => {
   if (!req.query.id && typeof req.query.id !== 'string') {
      return res.status(400).json({ error: 'keyword ID is Required!' });
   }
   // (This guard used to read `!req.body.tags === undefined`, a boolean-vs-undefined compare that
   // is always false, so the check never fired. Fixed to the intended empty-payload rejection.)
   if (req.body.sticky === undefined && req.body.tags === undefined && req.body.target_page === undefined) {
      return res.status(400).json({ error: 'keyword Payload Missing!' });
   }
   const keywordIDs = (req.query.id as string).split(',').map((item) => parseInt(item, 10));
   const { sticky, tags, target_page } = req.body;
   // Same work-or-reject contract as the POST path: a documented argument is either applied or
   // rejected loudly, never silently mangled.
   if (target_page !== undefined && typeof target_page !== 'string') {
      return res.status(400).json({ error: 'target_page must be a string when provided.' });
   }

   try {
      const scope = scopeWhere(account);
      const keywords: KeywordType[] = [];
      if (target_page !== undefined) {
         await Keyword.update({ target_page: target_page.trim() }, { where: { ID: { [Op.in]: keywordIDs }, ...scope } });
         const updatedKeywords:Keyword[] = await Keyword.findAll({ where: { ID: { [Op.in]: keywordIDs }, ...scope } });
         const formattedKeywords = updatedKeywords.map((el) => el.get({ plain: true }));
         // The write response is compact: the caller set a target page, they do not need the raw
         // 100-position SERP echoed back per keyword. serpTop + serpResultCount replace lastResult.
         return res.status(200).json({ keywords: parseKeywords(formattedKeywords).map(compactKeywordResponse) });
      }
      if (sticky !== undefined) {
         await Keyword.update({ sticky }, { where: { ID: { [Op.in]: keywordIDs }, ...scope } });
         const updateQuery = { where: { ID: { [Op.in]: keywordIDs }, ...scope } };
         const updatedKeywords:Keyword[] = await Keyword.findAll(updateQuery);
         const formattedKeywords = updatedKeywords.map((el) => el.get({ plain: true }));
         return res.status(200).json({ keywords: parseKeywords(formattedKeywords).map(compactKeywordResponse) });
      }
      if (tags) {
         const tagsKeywordIDs = Object.keys(tags);
         const multipleKeywords = tagsKeywordIDs.length > 1;
         for (const keywordID of tagsKeywordIDs) {
            const selectedKeyword = await Keyword.findOne({ where: { ID: keywordID, ...scope } });
            const currentTags = selectedKeyword && selectedKeyword.tags ? JSON.parse(selectedKeyword.tags) : [];
            const mergedTags = Array.from(new Set([...currentTags, ...tags[keywordID]]));
            if (selectedKeyword) {
               await selectedKeyword.update({ tags: JSON.stringify(multipleKeywords ? mergedTags : tags[keywordID]) });
            }
         }
         return res.status(200).json({ keywords });
      }
      return res.status(400).json({ error: 'Invalid Payload!' });
   } catch (error) {
      console.log('[ERROR] Updating Keyword. ', error);
      // A13: the DB update threw, so the keywords were NOT updated. Server error, not 200.
      return res.status(500).json({ error: 'Error Updating keywords!' });
   }
};
