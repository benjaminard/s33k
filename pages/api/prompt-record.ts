import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import PromptCheck from '../../database/models/promptCheck';
import type Account from '../../database/models/account';

// POST /api/prompt-record
//
// The result write-back. After the USER'S OWN LLM queries an AI engine (ChatGPT / Claude /
// Perplexity / Gemini) with a tracked prompt, it calls THIS to record what it found: whether s33k's
// domain was cited, at what position, and the cited URL. s33k itself NEVER queries an engine: it has
// no server-side LLM (verified-true trust property, see SECURITY.md / CLAUDE.md). This route is the
// boundary that keeps that true: it only persists a result the caller supplies.
//
// Target a row by { id } or by { domain, prompt }. Owner-gated write: the caller must OWN the row's
// domain, and the update is owner-scoped, so a caller can only record onto its OWN PromptCheck row.

// The engines a result may be recorded for. Matches the AI engines s33k classifies elsewhere.
const KNOWN_ENGINES = new Set(['chatgpt', 'claude', 'perplexity', 'gemini', 'copilot']);

type PromptRecordResponse = {
   promptCheck?: Record<string, unknown>,
   updated?: number,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<PromptRecordResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed. Use POST.' }); }
   return recordResult(req, res, account);
}

// Parse an optional citation position: a finite integer >= 1, or null when omitted. A present-but-
// invalid position is a hard error so a bad value never silently lands.
const parsePosition = (raw: unknown): { ok: boolean, value: number | null } => {
   if (raw === undefined || raw === null || raw === '') { return { ok: true, value: null }; }
   let n = NaN;
   if (typeof raw === 'number') { n = raw; } else if (typeof raw === 'string') { n = Number(raw.trim()); }
   if (!Number.isInteger(n) || n < 1) { return { ok: false, value: null }; }
   return { ok: true, value: n };
};

const recordResult = async (req: NextApiRequest, res: NextApiResponse<PromptRecordResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};

   const id = (body.id !== undefined && body.id !== null && body.id !== '') ? Number(body.id) : NaN;
   const hasId = Number.isInteger(id);
   const domain = typeof body.domain === 'string' ? canonicalizeDomain(body.domain) : '';
   const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

   const engine = typeof body.engine === 'string' ? body.engine.trim().toLowerCase() : '';
   const { cited } = body;
   const parsedPosition = parsePosition(body.position);
   const citedUrl = typeof body.cited_url === 'string' && body.cited_url.trim() ? body.cited_url.trim() : null;

   // Selector: either an id, or a domain+prompt pair. Both absent is a 400.
   if (!hasId && !(domain && prompt)) {
      return res.status(400).json({ error: 'Provide id, or domain and prompt, to identify the tracked prompt.' });
   }
   if (typeof cited !== 'boolean') {
      return res.status(400).json({ error: 'cited must be a boolean.' });
   }
   if (!KNOWN_ENGINES.has(engine)) {
      return res.status(400).json({ error: `engine must be one of: ${Array.from(KNOWN_ENGINES).join(', ')}.` });
   }
   if (!parsedPosition.ok) {
      return res.status(400).json({ error: 'position must be an integer >= 1 if provided.' });
   }

   try {
      // Resolve the row owner-scoped so a caller only ever sees its OWN prompt rows.
      const selector: Record<string, unknown> = hasId
         ? { ID: id, ...scopeWhere(account) }
         : { domain, prompt, ...scopeWhere(account) };
      const row = await PromptCheck.findOne({ where: selector });
      if (!row) { return res.status(404).json({ error: 'Tracked prompt not found for this account.' }); }

      // Owner-gated write: confirm the caller OWNS the row's domain before mutating it. This is the
      // safer (owner-only) gate: a read-share viewer can never record a result. The row's domain is
      // already canonical, so the gate and the row agree on the same string.
      const owned = await resolveDomainAccess(account, String((row.get({ plain: true }) as Record<string, unknown>).domain), { write: true });
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

      // When uncited, position/cited_url carry no meaning: store them as null regardless of input.
      const updates = {
         engine,
         cited,
         position: cited ? parsedPosition.value : null,
         cited_url: cited ? citedUrl : null,
         checked_at: new Date().toJSON(),
      };
      await row.update(updates);
      return res.status(200).json({ updated: 1, promptCheck: row.get({ plain: true }) as Record<string, unknown> });
   } catch (error) {
      console.log('[ERROR] Recording prompt result: ', error);
      return res.status(400).json({ error: 'Error Recording Prompt Result.' });
   }
};
