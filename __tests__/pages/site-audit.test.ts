/**
 * site-audit route: a prioritized on-page SEO issue list from a crawl. Mocks the models, authorize,
 * and the network crawler (crawlSite); the real auditSite rule logic runs over fixture pages.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/site-crawl', () => ({ __esModule: true, crawlSite: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/site-audit';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { crawlSite } from '../../utils/site-crawl';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockCrawl = crawlSite as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

// A clean, well-formed page (good title length, good meta, single H1, plenty of body text).
const goodPage = {
   url: 'https://getmasset.com/',
   path: '/',
   title: 'Masset: The AI-Ready DAM for B2B Marketing Teams',
   metaDescription: 'Masset is the content home for B2B marketing teams. Find, trust, use, and measure your assets across every AI tool.',
   h1: ['The content home for B2B marketing teams'],
   h2: ['How it works'],
   excerpt: 'x'.repeat(400),
};

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
});

describe('GET /api/site-audit', () => {
   it('flags missing title, missing H1, missing meta, length and thin-content issues, sorted by severity', async () => {
      mockCrawl.mockResolvedValue({
         pages: [
            goodPage,
            // Missing title (high), missing H1 (high), missing meta (medium), thin content (low).
            { url: 'https://getmasset.com/empty', path: '/empty', title: '', metaDescription: '', h1: [], h2: [], excerpt: 'short' },
            // Title too long (low), meta too long (low), multiple H1s (medium).
            {
               url: 'https://getmasset.com/long',
               path: '/long',
               title: 'A'.repeat(80),
               metaDescription: 'B'.repeat(200),
               h1: ['One', 'Two'],
               excerpt: 'y'.repeat(400),
            },
         ],
         error: null,
      });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      const { report } = res.payload;
      expect(report.pagesAudited).toBe(3);
      expect(report.bySeverity.high).toBe(2); // missing title + missing H1
      expect(report.bySeverity.medium).toBe(2); // missing meta + multiple H1s
      expect(report.bySeverity.low).toBe(3); // thin content + title too long + meta too long

      // Sorted high first.
      expect(report.issues[0].severity).toBe('high');
      const lastSeverity = report.issues[report.issues.length - 1].severity;
      expect(lastSeverity).toBe('low');

      const empty = report.issues.filter((i: any) => i.page === '/empty').map((i: any) => i.issue);
      expect(empty).toEqual(expect.arrayContaining(['Missing title', 'Missing H1', 'Missing meta description', 'Thin content']));
   });

   it('detects duplicate titles shared across pages', async () => {
      mockCrawl.mockResolvedValue({
         pages: [
            { ...goodPage, path: '/a', url: 'https://getmasset.com/a', title: 'Identical Title For Both Pages Here' },
            { ...goodPage, path: '/b', url: 'https://getmasset.com/b', title: 'Identical Title For Both Pages Here' },
         ],
         error: null,
      });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      const dupes = res.payload.report.issues.filter((i: any) => i.issue === 'Duplicate title');
      expect(dupes.map((d: any) => d.page).sort()).toEqual(['/a', '/b']);
      expect(dupes[0].severity).toBe('medium');
   });

   it('skips unreachable pages (those carrying a crawl error) and surfaces the crawl error', async () => {
      mockCrawl.mockResolvedValue({
         pages: [
            goodPage,
            {
               url: 'https://getmasset.com/dead',
               path: '/dead',
               title: '',
               metaDescription: '',
               h1: [],
               h2: [],
               excerpt: '',
               error: 'Could not fetch this page.',
            },
         ],
         error: 'Partial crawl.',
      });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      // Only the one fetched page is audited; the errored page is not turned into false "missing" issues.
      expect(res.payload.report.pagesAudited).toBe(1);
      expect(res.payload.report.issues.some((i: any) => i.page === '/dead')).toBe(false);
      expect(res.payload.error).toBe('Partial crawl.');
   });

   it('returns a clean report with zero issues for well-formed pages', async () => {
      mockCrawl.mockResolvedValue({ pages: [goodPage], error: null });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.report.issueCount).toBe(0);
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
      expect(mockCrawl).not.toHaveBeenCalled();
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });

   it('401s when not authorized', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'no key' });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(401);
   });
});
