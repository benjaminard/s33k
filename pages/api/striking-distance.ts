import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import type Account from '../../database/models/account';
import { findStrikingDistance, StrikingInput, StrikingKeyword } from '../../utils/striking-distance';

// GET /api/striking-distance?domain=&min=4&max=30
//
// The highest-ROI SEO to-do list. Scans tracked keyword ranks and returns the near-miss "quick win"
// keywords currently ranking just off page one (default positions 4 to 30, the striking distance).
// Each is annotated with its position delta over the tracked history (negative == improving), so a
// marketer sees not just "close to page one" but "close AND climbing" (lean in) versus "close but
// slipping" (defend). Sorted by closeness to page one then by recent improvement. Pure query over
// the Keyword table, no LLM.

type Resp = {
   domain?: string,
   window?: { min: number, max: number },
   total?: number,
   keywords?: StrikingKeyword[],
   note?: string,
   error?: string | null,
};

// Clamp the window to a sane Google-rank range (1..100) and ensure min <= max. The defaults (4..30)
// are the conventional striking distance: 4 because 1 to 3 is already page one, 30 because beyond
// that the climb is too far to be a "quick" win.
const parseBound = (raw: unknown, fallback: number): number => {
   const n = parseInt(String(raw), 10);
   if (!Number.isFinite(n)) { return fallback; }
   return Math.min(100, Math.max(1, n));
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getStrikingDistance(req, res, account);
}

const getStrikingDistance = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   // Verify the caller owns this domain before reading any keyword data for it. scopeWhere lets
   // admin / MULTI_TENANT-off callers match any domain and limits a tenant to their own rows.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   const min = parseBound(q.min, 4);
   const max = Math.max(min, parseBound(q.max, 30));

   try {
      const keywordRows = await Keyword.findAll({
         where: { domain, ...scopeWhere(account) },
         attributes: ['keyword', 'position', 'url', 'history'],
      });
      const keywords: StrikingInput[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return {
            keyword: String(p.keyword || ''),
            position: Number(p.position) || 0,
            url: String(p.url || ''),
            history: String(p.history || ''),
         };
      });

      const striking = findStrikingDistance(keywords, min, max);
      const improving = striking.filter((k) => k.positionDelta !== null && k.positionDelta < 0).length;
      const note = striking.length === 0
         ? `No tracked keywords are in the striking window (positions ${min} to ${max}) yet. `
            + 'Add or refresh keywords so near-page-one wins can surface.'
         : `${striking.length} keyword(s) in striking distance (positions ${min} to ${max}). `
            + `${improving} are already improving. Work these first: the page already ranks, a small push wins page one.`;

      return res.status(200).json({
         domain,
         window: { min, max },
         total: striking.length,
         keywords: striking,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Striking Distance for ', domain, error);
      return res.status(400).json({ error: 'Error Building Striking Distance for this Domain.' });
   }
};
