/**
 * content-performance route: ranks a domain's pages by pageviews and joins, per page, entries
 * (sessions that landed there), optional goal conversions+rate (view-attributed), and the tracked
 * keywords whose target page is that page. Mocks the models; the real buildContentPerformance +
 * sessionize logic runs.
 */
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/content-performance';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockGoal = GoalModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

// A pageview event. is_bot defaults false (human). created drives session ordering.
let clock = 0;
const ev = (session: string, page: string, opts: Partial<{ source: string, is_bot: boolean, type: string }> = {}) => {
   clock += 1;
   return row({
      session,
      source: opts.source ?? null,
      is_bot: opts.is_bot ?? false,
      device: 'desktop',
      country: 'US',
      page,
      type: opts.type ?? 'pageview',
      created: new Date(1_700_000_000_000 + clock * 1000).toJSON(),
   });
};

const kw = (keyword: string, position: number, targetPage: string) => row({ keyword, position, target_page: targetPage });

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
   clock = 0;
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockGoal.findOne.mockResolvedValue(null);
   mockKeyword.findAll.mockResolvedValue([
      kw('ai-ready dam', 3, 'https://getmasset.com/dam'),
      kw('dam mcp server', 8, '/dam'), // second keyword on the same page
      kw('seismic alternative', 38, '/seismic'), // tracked page that gets zero traffic
   ]);
   // Three human sessions:
   //  s1: lands on /dam, then views /pricing (2 pageviews, entry = /dam, converts at /pricing).
   //  s2: lands on /dam (1 pageview, entry = /dam).
   //  s3: lands on /pricing only (1 pageview, entry = /pricing).
   // One bot session s4 lands on /dam (excluded by default).
   mockEvent.findAll.mockResolvedValue([
      ev('s1', '/dam', { source: 'organic-search' }),
      ev('s1', '/pricing'),
      ev('s2', '/dam', { source: 'direct' }),
      ev('s3', '/pricing', { source: 'referral' }),
      ev('s4', '/dam', { is_bot: true }),
   ]);
});

describe('GET /api/content-performance', () => {
   it('ranks pages by pageviews and reports entries + joined keywords, human-only by default', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);

      const pages = res.payload.report.pages;
      const dam = pages.find((p: any) => p.page === '/dam');
      const pricing = pages.find((p: any) => p.page === '/pricing');

      // /dam: human pageviews from s1 + s2 = 2 (s4 bot excluded). entries = s1 + s2 landed there = 2.
      expect(dam.pageviews).toBe(2);
      expect(dam.entries).toBe(2);
      // /pricing: human pageviews from s1 + s3 = 2. entries = s3 only landed there = 1.
      expect(pricing.pageviews).toBe(2);
      expect(pricing.entries).toBe(1);

      // Tracked keywords join onto /dam (sorted by position), and /pricing ranks for nothing.
      expect(dam.keywords.map((k: any) => k.keyword)).toEqual(['ai-ready dam', 'dam mcp server']);
      expect(dam.keywords[0].position).toBe(3);
      expect(pricing.keywords).toEqual([]);

      // totalPageviews counts only human pageviews (2 + 2 = 4).
      expect(res.payload.report.totalPageviews).toBe(4);
   });

   it('includes a tracked page that gets zero traffic (ranking-without-traffic) ranked last', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const seismic = res.payload.report.pages.find((p: any) => p.page === '/seismic');
      expect(seismic.pageviews).toBe(0);
      expect(seismic.entries).toBe(0);
      expect(seismic.keywords.map((k: any) => k.keyword)).toEqual(['seismic alternative']);
   });

   it('folds bot sessions back in when includeBots=true', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', includeBots: 'true' }), res);
      const dam = res.payload.report.pages.find((p: any) => p.page === '/dam');
      // Now the s4 bot pageview on /dam counts: 3 pageviews, 3 entries (all three landed on /dam).
      expect(dam.pageviews).toBe(3);
      expect(dam.entries).toBe(3);
      expect(res.payload.botSessionsExcluded).toBe(0);
   });

   it('adds view-attributed conversions + rate when a goal is supplied', async () => {
      // page_reached goal: any session that viewed /pricing converted. s1 viewed both /dam and
      // /pricing, so the conversion credits BOTH pages it saw (view-attribution).
      mockGoal.findOne.mockResolvedValue(row({
         ID: 9, name: 'Pricing Viewed', kind: 'page_reached', match_value: '/pricing', match_page: null, match_mode: 'prefix',
      }));
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Pricing Viewed' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.goal).toEqual({ id: 9, name: 'Pricing Viewed' });

      const dam = res.payload.report.pages.find((p: any) => p.page === '/dam');
      const pricing = res.payload.report.pages.find((p: any) => p.page === '/pricing');
      // /dam viewers: s1, s2 (2). Only s1 converted (it saw /pricing) -> 1/2 = 50%.
      expect(dam.conversions).toBe(1);
      expect(dam.conversionRatePct).toBe(50);
      // /pricing viewers: s1, s3 (2). Both saw /pricing so both converted -> 2/2 = 100%.
      expect(pricing.conversions).toBe(2);
      expect(pricing.conversionRatePct).toBe(100);
   });

   it('respects the limit (top N by pageviews)', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', limit: '1' }), res);
      const pages = res.payload.report.pages;
      expect(pages).toHaveLength(1);
      expect(pages[0].page).toBe('/dam'); // top by pageviews (tie broken by entries)
   });

   it('404s when a named goal does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });
});
