import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Segment from '../../database/models/segment';
import type Account from '../../database/models/account';
import { normalizeSegmentSpec } from '../../utils/segmentFilters';

// /api/segments  -  CRUD for NAMED, reusable filter sets (see database/models/segment.ts).
//   GET    ?domain=            list a domain's segments
//   POST   { domain, name, filters }   create a segment (filters is the SegmentFilters spec object)
//   DELETE ?id=                delete a segment
// Every operation is ownership-gated (scopeWhere) so a tenant only ever touches its own segments.
// The stored `filters` is a JSON string of the SegmentFilters spec; segment-analytics applies it
// through the same sessionize engine as human-analytics, so the filter vocabulary never diverges.

type SegmentsResponse = {
   segments?: Record<string, unknown>[],
   segment?: Record<string, unknown>,
   removed?: number,
   error?: string | null,
};

// Parse the stored JSON filters string back into a plain object for the response (so callers see the
// spec, not the raw string). A malformed string (should never happen, we wrote it) falls back to {}.
const toPlainSegment = (s: Segment): Record<string, unknown> => {
   const plain = s.get({ plain: true }) as Record<string, unknown>;
   let parsed: Record<string, unknown> = {};
   try { parsed = JSON.parse(String(plain.filters || '{}')); } catch { parsed = {}; }
   return { ...plain, filters: parsed };
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<SegmentsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method === 'GET') { return listSegments(req, res, account); }
   if (req.method === 'POST') { return createSegment(req, res, account); }
   if (req.method === 'DELETE') { return deleteSegment(req, res, account); }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const listSegments = async (req: NextApiRequest, res: NextApiResponse<SegmentsResponse>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   try {
      const where = domain ? { domain, ...scopeWhere(account) } : { ...scopeWhere(account) };
      const segments = await Segment.findAll({ where });
      return res.status(200).json({ segments: segments.map((s) => toPlainSegment(s)) });
   } catch (error) {
      console.log('[ERROR] Listing segments: ', error);
      return res.status(400).json({ error: 'Error Listing Segments.' });
   }
};

const createSegment = async (req: NextApiRequest, res: NextApiResponse<SegmentsResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   const name = typeof body.name === 'string' ? body.name.trim() : '';
   // filters may arrive as an object (preferred) or a JSON string; normalizeSegmentSpec accepts both
   // and keeps only the known SegmentFilters keys, so junk keys never get stored.
   const spec = normalizeSegmentSpec(body.filters);

   if (!domain || !name) {
      return res.status(400).json({ error: 'domain and name are required.' });
   }
   // Cap the name length so a >255-char name does not silently truncate on a Postgres VARCHAR(255).
   if (name.length > 255) {
      return res.status(400).json({ error: 'Segment name must be 255 characters or fewer.' });
   }
   if (Object.keys(spec).length === 0) {
      return res.status(400).json({
         error: 'filters must include at least one known filter (channel, device, country, humanOnly, landingPage, page, engagement).',
      });
   }
   try {
      // Ownership gate: the caller must own the domain before defining a segment on it.
      const owned = await resolveDomainAccess(account, domain, { write: true });
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

      const segment = await Segment.create({
         domain,
         owner_id: ownerIdFor(account),
         name,
         filters: JSON.stringify(spec),
         created: new Date().toJSON(),
      });
      return res.status(201).json({ segment: toPlainSegment(segment) });
   } catch (error) {
      console.log('[ERROR] Creating segment: ', error);
      return res.status(400).json({ error: 'Error Creating Segment.' });
   }
};

const deleteSegment = async (req: NextApiRequest, res: NextApiResponse<SegmentsResponse>, account?: Account | null) => {
   const id = typeof req.query.id === 'string' ? parseInt(req.query.id, 10) : NaN;
   if (!Number.isFinite(id)) { return res.status(400).json({ error: 'Segment id is required.' }); }
   try {
      const removed = await Segment.destroy({ where: { ID: id, ...scopeWhere(account) } });
      return res.status(200).json({ removed });
   } catch (error) {
      console.log('[ERROR] Deleting segment: ', error);
      return res.status(400).json({ error: 'Error Deleting Segment.' });
   }
};
