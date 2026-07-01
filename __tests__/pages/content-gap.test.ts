/**
 * content-gap route: topics a competitor covers that you do not. Mocks the models, authorize, and
 * crawlSite (so no network runs); the real computeContentGaps/deriveTopic logic runs over the
 * mocked crawl pages.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/site-crawl', () => ({ __esModule: true, crawlSite: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/content-gap';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { crawlSite } from '../../utils/site-crawl';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockCrawl = crawlSite as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const page = (path: string, title: string, excerpt: string, error?: string) => ({
   url: `https://example.com${path}`, path, title, metaDescription: '', h1: [], h2: [], excerpt, error,
});
const crawlResult = (domain: string, pages: any[], error?: string) =>
   ({ domain, homeUrl: `https://${domain}/`, discoveredVia: 'sitemap', pageCount: pages.length, pages, error });

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
   mockKeyword.findAll.mockResolvedValue([]);

   // crawlSite is called for the competitor, then your domain (Promise.all order is competitor,
   // domain). mockImplementation routes by which domain was asked for so order does not matter.
   mockCrawl.mockImplementation(async (d: string) => {
      if (d === 'competitor.com') {
         return crawlResult('competitor.com', [
            page('/', 'Competitor Home | Brand', 'home page'),
            // Rich page (long excerpt) on a topic you do NOT cover -> top gap.
            page('/highspot-alternative', 'Highspot Alternative', 'a'.repeat(500)),
            // Thinner page, also a gap.
            page('/seismic-alternative', 'Seismic Alternative', 'b'.repeat(100)),
            // Topic you DO cover (dam mcp) -> filtered out.
            page('/dam-mcp-server', 'DAM MCP Server', 'c'.repeat(300)),
            // Generic page -> skipped.
            page('/privacy', 'Privacy Policy', 'legal'),
            // Unfetchable page -> skipped.
            page('/broken', '', '', 'Could not fetch this page.'),
         ]);
      }
      // your domain
      return crawlResult('getmasset.com', [
         page('/', 'Masset Home', 'home'),
         page('/dam-mcp', 'DAM MCP', 'you already wrote about the dam mcp'),
      ]);
   });
});

describe('GET /api/content-gap', () => {
   it('returns competitor topics with no match on your site, sorted by richness desc', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', competitor: 'competitor.com' }), res);
      expect(res.statusCode).toBe(200);
      const topics = res.payload.gaps.map((g: any) => g.topic);
      // dam mcp server is covered (matches your "dam mcp"); privacy + home + broken are excluded.
      expect(topics).toEqual(['highspot alternative', 'seismic alternative']);
      expect(res.payload.total).toBe(2);
      // Richest competitor page (500-char excerpt) ranks first.
      expect(res.payload.gaps[0].topic).toBe('highspot alternative');
      expect(res.payload.gaps[0].url).toBe('https://example.com/highspot-alternative');
   });

   it('folds tracked keywords/target pages into your covered topics', async () => {
      // Now you track "seismic alternative" too, so only highspot remains a gap.
      mockKeyword.findAll.mockResolvedValue([
         row({ keyword: 'seismic alternative', target_page: '/seismic-alt' }),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', competitor: 'competitor.com' }), res);
      const topics = res.payload.gaps.map((g: any) => g.topic);
      expect(topics).toEqual(['highspot alternative']);
   });

   it('surfaces a note and empty gaps when the competitor crawl is empty', async () => {
      mockCrawl.mockImplementation(async (d: string) => {
         if (d === 'competitor.com') { return crawlResult('competitor.com', [], 'Could not reach competitor.com.'); }
         return crawlResult('getmasset.com', [page('/', 'Home', 'home')]);
      });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', competitor: 'competitor.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.total).toBe(0);
      expect(res.payload.gaps).toEqual([]);
      expect(res.payload.note).toMatch(/Could not read any pages/);
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com', competitor: 'competitor.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({ competitor: 'competitor.com' }), res);
      expect(res.statusCode).toBe(400);
   });

   it('400s when competitor is missing', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(400);
   });
});
