import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { findStrikingDistance, StrikingInput } from '../../utils/striking-distance';
import { sessionize, EventLike } from '../../utils/sessionize';

// GET /api/portfolio?period=
//
// The "how are all my sites doing" rollup. One call summarizes EVERY domain on the caller's account
// at once, so an agency or multi-site owner gets a single portfolio view instead of calling the
// per-domain SEO/analytics tools once per site. There is NO domain param: it spans exactly the
// caller's own domains (scoped by scopeWhere, so a tenant only ever sees their own sites).
//
// Per domain it returns a COMPACT summary (counts, never full lists) so the payload stays small even
// across many sites: the keyword rank distribution (total tracked, in top 3 / top 10 / page one /
// not in top 100), a striking-distance count as the top SEO opportunity signal (reusing the same
// findStrikingDistance logic the striking_distance tool uses), and, when first-party events exist for
// that domain in the period, the human and AI-referral session counts (reusing sessionize + the
// channel classification: AI sessions are channel 'ai'). Cross-pillar, pure query, no LLM.

type DomainKeywordSummary = {
   total: number,
   inTop3: number,
   inTop10: number,
   onPageOne: number,
   notInTop100: number,
};

type DomainTraffic = {
   humanSessions: number,
   aiSessions: number,
};

type PortfolioDomain = {
   domain: string,
   keywords: DomainKeywordSummary,
   strikingDistanceCount: number,
   // null when this domain has no first-party events in the window (tracking not installed or no
   // traffic yet), distinguishing "zero traffic measured" from "analytics not wired up here".
   traffic: DomainTraffic | null,
};

type PortfolioResponse = {
   period?: string,
   domains?: PortfolioDomain[],
   note?: string,
   error?: string | null,
};

// Bound the rollup so a very large account cannot turn one call into an unbounded scan. Beyond this
// many domains we truncate with an honest note; an agency with more can drill in per-site.
const MAX_PORTFOLIO_DOMAINS = 100;

export default async function handler(req: NextApiRequest, res: NextApiResponse<PortfolioResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getPortfolio(req, res, account);
}

// Roll a domain's tracked keyword positions into the rank distribution. position 0 means "not in the
// top 100" (SerpBear stores 0 for an unranked/unfound term), so it counts only toward notInTop100.
const summarizeKeywords = (positions: number[]): DomainKeywordSummary => {
   const summary: DomainKeywordSummary = { total: positions.length, inTop3: 0, inTop10: 0, onPageOne: 0, notInTop100: 0 };
   for (const p of positions) {
      const pos = Number(p) || 0;
      if (pos <= 0) {
         summary.notInTop100 += 1;
      } else {
         if (pos <= 3) { summary.inTop3 += 1; }
         if (pos <= 10) { summary.inTop10 += 1; }
         if (pos <= 10) { summary.onPageOne += 1; } // page one is the first 10 results
      }
   }
   return summary;
};

const getPortfolio = async (req: NextApiRequest, res: NextApiResponse<PortfolioResponse>, account?: Account | null) => {
   const q = req.query;
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   try {
      // Only the caller's own domains. scopeWhere returns {} for admin / MULTI_TENANT-off, so this is
      // every domain in single-tenant mode, and exactly the tenant's domains otherwise.
      const domainRows = await Domain.findAll({ where: { ...scopeWhere(account) } });
      if (domainRows.length === 0) {
         return res.status(200).json({
            period,
            domains: [],
            note: 'No domains tracked on this account yet. Add a domain and some keywords to populate the portfolio.',
            error: null,
         });
      }

      // Cap the number of domains processed so a very large account cannot turn one portfolio call into
      // an unbounded scan. Beyond the cap we truncate with an honest note rather than silently dropping.
      const allNames = domainRows.map((d) => String((d.get({ plain: true }) as Record<string, unknown>).domain || '')).filter(Boolean);
      const names = allNames.slice(0, MAX_PORTFOLIO_DOMAINS);
      const truncated = allNames.length - names.length;

      // The S33kEvent window is clamped once via periodStartMs (which itself caps lookback at 365d).
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();

      // Batch the per-domain reads into TWO grouped Op.in queries (keywords, events) instead of two
      // queries PER domain, so the round-trip count is constant (3 total) no matter how many domains the
      // account has. Both are scoped + bounded (the cap above, and the clamped window for events).
      const keywordRows = await Keyword.findAll({
         where: { domain: { [Op.in]: names }, ...scopeWhere(account) },
         attributes: ['domain', 'keyword', 'position', 'url', 'history'],
      });
      const eventRows = await S33kEvent.findAll({
         where: { domain: { [Op.in]: names }, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'domain', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });

      // Group both result sets by domain in memory so each domain's summary reads from its own slice.
      const keywordsByDomain = new Map<string, Record<string, unknown>[]>();
      keywordRows.forEach((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         const dom = String(p.domain || '');
         const list = keywordsByDomain.get(dom) || [];
         list.push(p);
         keywordsByDomain.set(dom, list);
      });
      const eventsByDomain = new Map<string, EventLike[]>();
      eventRows.forEach((r) => {
         const p = r.get({ plain: true }) as EventLike & { domain?: string };
         const dom = String(p.domain || '');
         const list = eventsByDomain.get(dom) || [];
         list.push(p);
         eventsByDomain.set(dom, list);
      });

      const domains: PortfolioDomain[] = names.map((domain) => {
         // SEO: derive the rank distribution and the striking-distance count from the same keyword rows
         // (reusing findStrikingDistance, no duplication).
         const kwRows = keywordsByDomain.get(domain) || [];
         const positions: number[] = [];
         const strikingInput: StrikingInput[] = [];
         kwRows.forEach((p) => {
            positions.push(Number(p.position) || 0);
            strikingInput.push({
               keyword: String(p.keyword || ''),
               position: Number(p.position) || 0,
               url: String(p.url || ''),
               history: String(p.history || ''),
            });
         });
         const keywords = summarizeKeywords(positions);
         const strikingDistanceCount = findStrikingDistance(strikingInput, 4, 30).length;

         // Analytics: count human vs AI-referral sessions in the window. traffic stays null when no
         // events exist, so the rollup distinguishes "no tracking here" from "0 sessions measured".
         const evRows = eventsByDomain.get(domain) || [];
         let traffic: DomainTraffic | null = null;
         if (evRows.length > 0) {
            const sessions = sessionize(evRows);
            // Human sessions exclude datacenter/bot sessions, matching the human-only default elsewhere.
            const human = sessions.filter((s) => !s.isBot);
            traffic = {
               humanSessions: human.length,
               aiSessions: human.filter((s) => s.channel === 'ai').length,
            };
         }

         return { domain, keywords, strikingDistanceCount, traffic };
      });

      // Sort by tracked-keyword count desc so the most-invested sites lead the portfolio.
      domains.sort((a, b) => b.keywords.total - a.keywords.total);

      const withTraffic = domains.filter((d) => d.traffic !== null).length;
      const capNote = truncated > 0 ? `${truncated} more domain(s) were omitted (portfolio is capped at ${MAX_PORTFOLIO_DOMAINS}). ` : '';
      const note = `${domains.length} domain(s) in this portfolio, sorted by tracked-keyword count. ${capNote}`
         + `${withTraffic} have first-party traffic in this window. `
         + 'Each domain shows its rank distribution, striking-distance quick-win count, and human / AI-referral sessions. '
         + 'Drill into a single site with the per-domain tools (striking_distance, page_scoreboard, channel_report).';

      return res.status(200).json({ period, domains, note, error: null });
   } catch (error) {
      console.log('[ERROR] Building Portfolio Rollup', error);
      return res.status(400).json({ error: 'Error Building Portfolio Rollup.' });
   }
};
