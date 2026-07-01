/**
 * seo-report route: the prebuilt SEO snapshot. ONE read of the Keyword table is bundled into four
 * sections (summary, strikingDistance, topMovers, rankingPages). We MOCK the models, sequelize Op,
 * and authorize so no real DB/model code loads; the real section-building + findStrikingDistance run.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
// Op is mocked even though seo-report does not use it directly: keeping the mock means the test never
// drags real sequelize ESM into jest if a future edit reaches for an operator.
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: 'in', gte: 'gte' } }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/seo-report';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

// A Keyword row exposes get({ plain: true }); we spread the data too so either access path works.
const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
// updating defaults false (rank check has landed) and lastUpdateError defaults 'false' (no error),
// matching how a settled keyword row looks. Tests override these to exercise the pending / failing
// scraper paths. lastUpdateError mirrors refresh.ts: 'false' or a JSON blob { date, error, scraper }.
const kw = (
   keyword: string,
   position: number,
   url: string,
   history: Record<string, number>,
   target_page = '',
   extra: Record<string, unknown> = {},
) => row({
   keyword,
   position,
   url: JSON.stringify([url]),
   history: JSON.stringify(history),
   target_page,
   updating: false,
   lastUpdateError: 'false',
   ...extra,
});
// Build a lastUpdateError blob exactly as refresh.ts writes it on a failed scrape.
const errBlob = (message: string) => JSON.stringify({ date: '2026-06-20T00:00:00.000Z', error: message, scraper: 'serper' });

const makeReq = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockKeyword.findAll.mockResolvedValue([
      // top 3, on page one. Improving 5 -> 2 (delta -3). Targets /dam.
      kw('masset', 2, 'https://getmasset.com/', { '2026-06-01': 5, '2026-06-16': 2 }, '/dam'),
      // page one (top 10 not top 3). Striking? no, position 8 is in window 4..30 -> yes striking. Targets /dam.
      kw('ai-ready dam', 8, 'https://getmasset.com/dam', { '2026-06-01': 14, '2026-06-16': 8 }, '/dam'),
      // striking distance, dropping 12 -> 18 (delta +6, the biggest drop). Targets /mcp.
      kw('dam mcp server', 18, 'https://getmasset.com/mcp', { '2026-06-01': 12, '2026-06-16': 18 }, '/mcp'),
      // not in top 100 (position 0). No target page.
      kw('how to make website ai readable', 0, 'https://getmasset.com/ai', {}, ''),
      // beyond striking window AND a big improvement 90 -> 45 (delta -45). No history-free. Targets /mcp.
      kw('serp tracking mcp', 45, 'https://getmasset.com/mcp', { '2026-06-01': 90, '2026-06-16': 45 }, '/mcp'),
   ]);
});

describe('GET /api/seo-report', () => {
   it('summarizes the rank distribution across all tracked keywords', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      const s = res.payload.summary;
      expect(s.totalKeywords).toBe(5);
      expect(s.inTop3).toBe(1); // only "masset" at position 2
      expect(s.inTop10).toBe(2); // position 2 and 8
      expect(s.onPageOne).toBe(2); // page one == top 10
      expect(s.notInTop100).toBe(1); // the position-0 keyword
   });

   it('reuses findStrikingDistance for the strikingDistance section (positions 4 to 30)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const terms = res.payload.strikingDistance.map((k: any) => k.keyword);
      // 8 and 18 are in the 4..30 window; 2 (page one), 0 (not ranked), 45 (beyond max) are excluded.
      expect(terms).toEqual(['ai-ready dam', 'dam mcp server']);
   });

   it('reports the biggest improvements and drops in topMovers', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const { improvements, drops } = res.payload.topMovers;
      // biggest climb is serp tracking mcp (90 -> 45, delta -45), then ai-ready dam (-6), then masset (-3).
      expect(improvements[0].keyword).toBe('serp tracking mcp');
      expect(improvements[0].delta).toBe(-45);
      // only one keyword dropped: dam mcp server (12 -> 18, delta +6).
      expect(drops.map((m: any) => m.keyword)).toEqual(['dam mcp server']);
      expect(drops[0].delta).toBe(6);
   });

   it('groups keywords by target_page in rankingPages, busiest page first, best rank first', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const pages = res.payload.rankingPages;
      const byPage = (p: string) => pages.find((x: any) => x.target_page === p);
      // /dam and /mcp each hold 2 keywords; the no-target-page bucket holds 1.
      expect(byPage('/dam').keywordCount).toBe(2);
      expect(byPage('/mcp').keywordCount).toBe(2);
      expect(byPage('(no target page)').keywordCount).toBe(1);
      // Within /dam, the better rank (masset at 2) sorts ahead of ai-ready dam at 8.
      expect(byPage('/dam').keywords.map((k: any) => k.keyword)).toEqual(['masset', 'ai-ready dam']);
   });

   it('honors a custom striking window via min/max', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', min: '4', max: '10' }), res);
      const terms = res.payload.strikingDistance.map((k: any) => k.keyword);
      expect(terms).toEqual(['ai-ready dam']); // position 18 now falls outside max=10
   });

   it('treats rank-pending keywords (updating) as pending, not as "not in the top 100"', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // a settled, ranking keyword
         kw('masset', 2, 'https://getmasset.com/', { '2026-06-16': 2 }, '/dam'),
         // two FRESH keywords: first Google check has not landed yet (updating true, position 0).
         kw('ai-ready dam', 0, 'https://getmasset.com/dam', {}, '/dam', { updating: true }),
         kw('dam mcp server', 0, 'https://getmasset.com/mcp', {}, '/mcp', { updating: true }),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      const s = res.payload.summary;
      // The two updating keywords are counted as pending, NOT as notInTop100 (which stays 0 here).
      expect(s.rankingsPending).toBe(2);
      expect(s.notInTop100).toBe(0);
      expect(s.totalKeywords).toBe(3);
      // The note LEADS with the pending state and does not call them "not in the top 100".
      expect(res.payload.note).toContain('First rank check is running for 2 keyword(s)');
      expect(res.payload.note.indexOf('First rank check is running')).toBe(0);
   });

   it('surfaces ONE honest note when most keywords fail with a scraper config / quota / auth error', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // 3 of 4 settled keywords failed their check for SERP-source reasons (no client, quota, auth).
         kw('masset', 0, 'https://getmasset.com/', {}, '', { lastUpdateError: errBlob('No scraper client available') }),
         kw('ai-ready dam', 0, 'https://getmasset.com/dam', {}, '', { lastUpdateError: errBlob('Serper API quota exceeded') }),
         kw('dam mcp server', 0, 'https://getmasset.com/mcp', {}, '', { lastUpdateError: errBlob('[401] Unauthorized: invalid api key') }),
         // one healthy ranking keyword, so the failures are the majority but not all.
         kw('serp tracking mcp', 5, 'https://getmasset.com/mcp', { '2026-06-16': 5 }, '/mcp'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      // Leads with the honest "SERP source is unconfigured or over quota" note, not a wall of "not ranked".
      expect(res.payload.note).toContain('Rank checks are failing: the SERP source is unconfigured or over quota');
      expect(res.payload.note).toContain('3 of 4 tracked keyword(s) could not be checked');
      // The note must NOT leak the provider name in user-facing text.
      expect(res.payload.note.toLowerCase()).not.toContain('serper');
      expect(res.payload.note.toLowerCase()).not.toContain('umami');
   });

   it('returns an empty-state note when no keywords are tracked', async () => {
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.summary.totalKeywords).toBe(0);
      expect(res.payload.strikingDistance).toEqual([]);
      expect(res.payload.note).toContain('No keywords are tracked');
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      const req = { method: 'POST', query: { domain: 'getmasset.com' }, body: {}, headers: {} } as unknown as NextApiRequest;
      await handler(req, res);
      expect(res.statusCode).toBe(405);
   });

   it('401s when authorize rejects the caller', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Unauthorized' });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(401);
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });
});
