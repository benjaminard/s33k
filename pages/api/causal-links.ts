import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, applyFilters, EventLike } from '../../utils/sessionize';
import { cleanPath } from '../../utils/clean-path';
import {
   computeCausalLinks, CausalKeywordInput, CausalEntryInput, CausalLinksResult,
} from '../../utils/causal-links';

// GET /api/causal-links?domain=&period=
//
// The cross-pillar join no single tool can do: for each page that has BOTH tracked-keyword rank
// history (SEO) AND first-party landing sessions (analytics), correlate the two series over time and
// report which rank change LIKELY drove which traffic change. Answers "did my SEO actually pay off?".
//
// RULES-BASED, correlation only: the server does the joins with transparent thresholds and returns
// structured links; it NEVER asserts causation and never calls an LLM. The user's own LLM narrates.
//
// Human-only by default (bots would pollute the traffic series). Ownership-gated, scoped,
// period-clamped, and resilient: a dead pillar degrades to an honest note, never a 500.

type Resp = {
   domain?: string,
   period?: string,
   links?: CausalLinksResult['links'],
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error: error || 'Not authorized' }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getCausalLinks(req, res, account);
}

const getCausalLinks = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Ownership gate first: the domain column is globally unique, so by-domain scoping cannot leak
   // across tenants. 403 before any pillar read.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      // periodStartMs clamps the lookback at 365 days (the shared DoS bound), so a hostile period=
      // cannot pull the whole event table into memory.
      const nowMs = Date.now();
      const periodStart = periodStartMs(period, nowMs);
      const startISO = new Date(periodStart).toJSON();

      // Pull both pillars in parallel. Each read is wrapped so a rejection degrades to empty (and the
      // composer's honest note) instead of 500ing the join.
      const [keywordRows, eventRows] = await Promise.all([
         Keyword.findAll({
            where: { domain, ...scopeWhere(account) },
            attributes: ['keyword', 'history', 'target_page'],
         }).catch(() => [] as Keyword[]),
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            // 'id' is selected so sessionize's deterministic tiebreaker works on Postgres.
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }).catch(() => [] as S33kEvent[]),
      ]);

      // Group tracked keywords by the page they target (cleanPath, the same normalizer briefing uses,
      // so keyword target pages and session landing pages join on the same key). Drop keywords with no
      // target_page: a causal link is per PAGE, and an untargeted keyword has no page to attribute.
      const keywordsByPage = new Map<string, CausalKeywordInput[]>();
      (keywordRows as Keyword[]).forEach((row) => {
         const k = row.get({ plain: true }) as Record<string, unknown>;
         const page = cleanPath(String(k.target_page || ''));
         if (!page) { return; }
         const list = keywordsByPage.get(page) || [];
         list.push({
            keyword: String(k.keyword),
            targetPage: page,
            history: String(k.history || '{}'),
         });
         keywordsByPage.set(page, list);
      });

      // Keep human-only (bots pollute the traffic series). sessionize gives the per-session LANDING
      // page; to bucket each entry by the DAY it happened we also need the session's start time, which
      // SessionAgg does not carry, so we derive each session's earliest `created` from the raw rows and
      // join it to the sessionized landing page by session id (the same key sessionize uses).
      const plainRows = (eventRows as S33kEvent[]).map((r) => r.get({ plain: true }) as EventLike);
      const earliestBySession = new Map<string, string>();
      plainRows.forEach((r) => {
         const id = r.session || `anon-${r.created}`;
         const cur = earliestBySession.get(id);
         if (cur === undefined || r.created < cur) { earliestBySession.set(id, r.created); }
      });

      const sessions = applyFilters(sessionize(plainRows), { humanOnly: true });
      const entriesByPage = new Map<string, CausalEntryInput[]>();
      sessions.forEach((s) => {
         const page = cleanPath(s.landingPage || '');
         if (!page) { return; }
         const createdISO = earliestBySession.get(s.id) || new Date(nowMs).toJSON();
         const list = entriesByPage.get(page) || [];
         list.push({ landingPage: page, createdISO });
         entriesByPage.set(page, list);
      });

      // Pass periodStart so the rank series is clamped to the SAME window as the entries (which are
      // already loaded with created >= startISO). Without it, a stale rank move from before the window
      // would correlate against an in-window traffic series that cannot speak to it.
      const result = computeCausalLinks({
         keywordsByPage, entriesByPage, nowMs, periodStartMs: periodStart,
      });

      return res.status(200).json({
         domain, period, links: result.links, note: result.note, error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Causal Links for ', domain, error);
      return res.status(400).json({ error: 'Error Building Causal Links for this Domain.' });
   }
};
