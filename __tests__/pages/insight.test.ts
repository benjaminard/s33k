/**
 * Route-level tests for GET /api/insight (pages/api/insight.ts) and its summary shaping
 * (utils/insight-summary.ts).
 *
 * WHY THESE EXIST (LLM ergonomics): the MCP tool surface is the product and an LLM context window
 * is its primary consumer. On a real Search Console property the raw insight payload was unbounded
 * (~113KB: hundreds of zero-click keyword rows plus full pages/countries/days arrays) and
 * overflowed the consuming LLM on its FIRST real use. The route is now summary-first and bounded
 * by default, mirroring the entry-pages conventions: bounded default, clamped limit param,
 * detail=true escape hatch, and a meta block (totals, truncated, hint).
 *
 * The Search Console read is mocked with a large fake payload (120 keywords, most zero-click);
 * the real insight helpers (getKeywordsInsight etc.) and the real summarizer run, so the bounds,
 * ranking, and aggregate math are genuinely exercised. Auth and domain access are mocked.
 */

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn(async () => ({ authorized: true, account: null })) }));
jest.mock('../../utils/domain-access', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   readLocalSCData: jest.fn(),
   fetchDomainSCData: jest.fn(),
   getSearchConsoleApiInfo: jest.fn(),
   hasSearchConsoleCredentials: jest.fn(),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/insight';
// eslint-disable-next-line import/first
import resolveDomainAccess from '../../utils/domain-access';
// eslint-disable-next-line import/first
import { readLocalSCData, getSearchConsoleApiInfo, hasSearchConsoleCredentials } from '../../utils/searchConsole';
// eslint-disable-next-line import/first
import {
   summarizeInsight,
   INSIGHT_DEFAULT_TOP_KEYWORDS,
   INSIGHT_DEFAULT_UNTAPPED_KEYWORDS,
   INSIGHT_DEFAULT_TOP_PAGES,
   INSIGHT_TOP_COUNTRIES,
   INSIGHT_LOW_CLICK_MAX,
} from '../../utils/insight-summary';

const mockResolveAccess = resolveDomainAccess as unknown as jest.Mock;
const mockReadLocal = readLocalSCData as unknown as jest.Mock;
const mockScApiInfo = getSearchConsoleApiInfo as unknown as jest.Mock;
const mockHasCreds = hasSearchConsoleCredentials as unknown as jest.Mock;

const KEYWORD_COUNT = 120;
const PAGE_COUNT = 40;

/**
 * A realistic large SC payload: 120 keywords over 40 pages and 2 countries. The first 10 keywords
 * carry clicks (descending); the long tail is zero-click but has impressions (descending with i),
 * exactly the shape that produced the 113KB real-world response.
 */
const buildSCData = (): Record<string, unknown> => {
   const thirtyDays = Array.from({ length: KEYWORD_COUNT }, (_, i) => ({
      keyword: `kw ${i}`,
      uid: `uid-${i}`,
      device: 'desktop',
      page: `https://example.com/page-${i % PAGE_COUNT}`,
      country: i % 2 === 0 ? 'usa' : 'gbr',
      clicks: i < 10 ? 100 - (i * 5) : 0,
      impressions: 5000 - (i * 10),
      ctr: 0.01,
      position: 8 + (i % 20),
   }));
   const stats = Array.from({ length: 30 }, (_, d) => ({
      date: `2026-06-${String(d + 1).padStart(2, '0')}`,
      clicks: 10 + d,
      impressions: 500 + d,
      ctr: 0.02,
      position: 12.34,
   }));
   return { threeDays: [], sevenDays: [], thirtyDays, stats, lastFetched: new Date().toJSON() };
};

const makeReq = (query: Record<string, string>): NextApiRequest => ({
   method: 'GET',
   query,
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn().mockImplementation((body: unknown) => { res.body = body; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, body: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockResolveAccess.mockResolvedValue({ domain: 'example.com', get: () => ({ domain: 'example.com' }) });
   mockReadLocal.mockResolvedValue(buildSCData());
});

describe('GET /api/insight: summary-first bounded default', () => {
   it('returns the bounded summary by default: default caps, compact rows, meta totals and hint', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'example.com' }), res);
      expect(res.statusCode).toBe(200);
      const { data } = res.body;

      // Bounded lists at the documented defaults.
      expect(data.topKeywordsByClicks).toHaveLength(INSIGHT_DEFAULT_TOP_KEYWORDS);
      expect(data.untappedKeywords).toHaveLength(INSIGHT_DEFAULT_UNTAPPED_KEYWORDS);
      expect(data.topPages).toHaveLength(INSIGHT_DEFAULT_TOP_PAGES);
      expect(data.topCountries.length).toBeLessThanOrEqual(INSIGHT_TOP_COUNTRIES);

      // Top keywords are ranked by clicks; the best row leads.
      expect(data.topKeywordsByClicks[0].keyword).toBe('kw 0');
      expect(data.topKeywordsByClicks[0].clicks).toBe(100);

      // Untapped = low-click rows ranked by impressions descending.
      data.untappedKeywords.forEach((k: any) => expect(k.clicks).toBeLessThanOrEqual(INSIGHT_LOW_CLICK_MAX));
      const impressions = data.untappedKeywords.map((k: any) => k.impressions);
      expect([...impressions].sort((a, b) => b - a)).toEqual(impressions);

      // Rows carry only the meaningful fields.
      expect(Object.keys(data.topKeywordsByClicks[0]).sort()).toEqual(['clicks', 'ctr', 'impressions', 'keyword', 'position']);
      expect(Object.keys(data.topPages[0]).sort()).toEqual(['clicks', 'ctr', 'impressions', 'page', 'position']);
      expect(Object.keys(data.topCountries[0]).sort()).toEqual(['clicks', 'country', 'ctr', 'impressions', 'position']);

      // Compact daily series: date, clicks, impressions, position only.
      expect(data.days).toHaveLength(30);
      expect(Object.keys(data.days[0]).sort()).toEqual(['clicks', 'date', 'impressions', 'position']);

      // Meta names the full totals, flags the cut, and tells the LLM about limit/detail.
      expect(data.meta.totals).toEqual({ keywords: KEYWORD_COUNT, pages: PAGE_COUNT, countries: 2, days: 30 });
      expect(data.meta.truncated).toBe(true);
      expect(data.meta.hint).toContain('limit=');
      expect(data.meta.hint).toContain('detail=true');
   });

   it('computes the aggregate stats from the daily series (clicks/impressions summed, ctr derived)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'example.com' }), res);
      const { stats } = res.body.data;
      // Sum over the 30 fixture days: clicks 10..39, impressions 500..529.
      const expectedClicks = Array.from({ length: 30 }, (_, d) => 10 + d).reduce((a, b) => a + b, 0);
      const expectedImpressions = Array.from({ length: 30 }, (_, d) => 500 + d).reduce((a, b) => a + b, 0);
      expect(stats.clicks).toBe(expectedClicks);
      expect(stats.impressions).toBe(expectedImpressions);
      expect(stats.ctr).toBeCloseTo(expectedClicks / expectedImpressions, 4);
      expect(stats.position).toBeCloseTo(12.3, 1);
      expect(stats.window).toBe('30d');
   });

   it('applies limit to the keyword and page lists and clamps it to 1..200', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'example.com', limit: '5' }), res);
      expect(res.body.data.topKeywordsByClicks).toHaveLength(5);
      expect(res.body.data.untappedKeywords).toHaveLength(5);
      expect(res.body.data.topPages).toHaveLength(5);

      // Clamp high: 10000 -> 200 covers everything, so nothing is truncated.
      const resHigh = makeRes();
      await handler(makeReq({ domain: 'example.com', limit: '10000' }), resHigh);
      expect(resHigh.body.data.topKeywordsByClicks).toHaveLength(KEYWORD_COUNT);
      expect(resHigh.body.data.topPages).toHaveLength(PAGE_COUNT);
      expect(resHigh.body.data.meta.truncated).toBe(false);

      // Clamp low: 0 -> 1.
      const resLow = makeRes();
      await handler(makeReq({ domain: 'example.com', limit: '0' }), resLow);
      expect(resLow.body.data.topKeywordsByClicks).toHaveLength(1);
   });

   it('detail=true returns the full legacy arrays with no truncation and no meta', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'example.com', detail: 'true' }), res);
      const { data } = res.body;
      expect(data.keywords).toHaveLength(KEYWORD_COUNT);
      expect(data.pages).toHaveLength(PAGE_COUNT);
      expect(data.countries).toHaveLength(2);
      expect(data.stats).toHaveLength(30);
      // Full-fidelity rows keep the legacy fields (e.g. ctr on daily stats).
      expect(data.stats[0]).toHaveProperty('ctr');
      expect(data.meta).toBeUndefined();
   });

   it('still reports "not integrated" unchanged when Search Console has no credentials', async () => {
      mockReadLocal.mockResolvedValue(false);
      mockScApiInfo.mockResolvedValue({});
      mockHasCreds.mockReturnValue(false);
      const res = makeRes();
      await handler(makeReq({ domain: 'example.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ data: null, error: 'Google Search Console is not Integrated.' });
   });
});

describe('summarizeInsight: aggregate fallback', () => {
   it('aggregates from the keyword rows when the daily stats series is empty', () => {
      const full = {
         stats: [],
         keywords: [
            { keyword: 'a', clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
            { keyword: 'b', clicks: 0, impressions: 300, ctr: 0, position: 20 },
         ],
         pages: [],
         countries: [],
      } as unknown as InsightDataType;
      const summary = summarizeInsight(full);
      expect(summary.stats.clicks).toBe(10);
      expect(summary.stats.impressions).toBe(400);
      expect(summary.stats.ctr).toBeCloseTo(0.025, 4);
      // Impressions-weighted position: (5*100 + 20*300) / 400 = 16.25 -> 16.3.
      expect(summary.stats.position).toBeCloseTo(16.3, 1);
   });
});
