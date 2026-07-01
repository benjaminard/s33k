import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import PromptCheck from '../../database/models/promptCheck';
import type Account from '../../database/models/account';

// /api/prompt-checks  -  track + list + delete buyer prompts whose AI-citation is watched.
//   GET    ?domain=            list a domain's tracked prompts and their latest recorded results
//   POST   { domain, prompt }  track a new prompt (created with NO result yet)
//   DELETE ?id=                delete a tracked prompt
//
// CRITICAL: s33k has NO server-side LLM. POST only STORES a prompt to watch; it never queries an AI
// engine. A result is written later, by the USER'S OWN LLM, via the separate prompt-record route.
//
// Every operation is ownership-gated (resolveDomainAccess / scopeWhere) so a tenant only ever touches
// its own prompts. The domain is canonicalized so a tracked prompt joins to the canonical Domain /
// Keyword / event rows the radar reads.

type PromptChecksResponse = {
   promptChecks?: Record<string, unknown>[],
   promptCheck?: Record<string, unknown>,
   removed?: number,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<PromptChecksResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method === 'GET') { return listPromptChecks(req, res, account); }
   if (req.method === 'POST') { return trackPrompt(req, res, account); }
   if (req.method === 'DELETE') { return deletePromptCheck(req, res, account); }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const listPromptChecks = async (req: NextApiRequest, res: NextApiResponse<PromptChecksResponse>, account?: Account | null) => {
   const raw = typeof req.query.domain === 'string' ? req.query.domain : '';
   if (!raw) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const domain = canonicalizeDomain(raw);
   try {
      // Read gate: the caller must be able to read this domain before listing its prompts.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }
      const rows = await PromptCheck.findAll({ where: { domain, ...scopeWhere(account) }, order: [['created', 'ASC']] });
      return res.status(200).json({ promptChecks: rows.map((r) => r.get({ plain: true }) as Record<string, unknown>) });
   } catch (error) {
      console.log('[ERROR] Listing prompt checks: ', error);
      return res.status(400).json({ error: 'Error Listing Prompt Checks.' });
   }
};

const trackPrompt = async (req: NextApiRequest, res: NextApiResponse<PromptChecksResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const rawDomain = typeof body.domain === 'string' ? body.domain : '';
   const domain = canonicalizeDomain(rawDomain);
   const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

   if (!domain || !prompt) {
      return res.status(400).json({ error: 'domain and prompt are required.' });
   }
   try {
      // Write gate: the caller must OWN the domain before tracking a prompt on it.
      const owned = await resolveDomainAccess(account, domain, { write: true });
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

      // Reject a duplicate prompt for this (domain, owner) so list/record resolvers do not pick an
      // arbitrary one of two identical prompts.
      const existing = await PromptCheck.findOne({ where: { domain, prompt, ...scopeWhere(account) } });
      if (existing) {
         return res.status(409).json({ error: 'That prompt is already tracked for this domain.' });
      }

      // Created with NO result. s33k stores the prompt only; the user's LLM records the result later.
      const created = await PromptCheck.create({
         domain,
         owner_id: ownerIdFor(account),
         prompt,
         engine: null,
         cited: null,
         position: null,
         cited_url: null,
         checked_at: null,
         created: new Date().toJSON(),
      });
      return res.status(201).json({ promptCheck: created.get({ plain: true }) as Record<string, unknown> });
   } catch (error) {
      console.log('[ERROR] Tracking prompt: ', error);
      return res.status(400).json({ error: 'Error Tracking Prompt.' });
   }
};

const deletePromptCheck = async (req: NextApiRequest, res: NextApiResponse<PromptChecksResponse>, account?: Account | null) => {
   const id = typeof req.query.id === 'string' ? parseInt(req.query.id, 10) : NaN;
   if (!Number.isFinite(id)) { return res.status(400).json({ error: 'Prompt id is required.' }); }
   try {
      // Owner-scoped destroy: scopeWhere confines deletion to the caller's own prompts, so a non-owner
      // id resolves to no row (removed: 0) rather than touching another tenant's prompt.
      const removed = await PromptCheck.destroy({ where: { ID: id, ...scopeWhere(account) } });
      return res.status(200).json({ removed });
   } catch (error) {
      console.log('[ERROR] Deleting prompt check: ', error);
      return res.status(400).json({ error: 'Error Deleting Prompt Check.' });
   }
};
