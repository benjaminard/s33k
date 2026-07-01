/**
 * Tests for pages/api/competitor-visibility.ts.
 *
 * Competitor share-of-voice reads the full SERP page that every tracked keyword already
 * stores in `lastResult` (a KeywordLastResult[] of { position, url, title, skipped? }),
 * tallies how often each EXTERNAL domain appears across the tracked domain's keywords,
 * and surfaces a per-keyword "who outranks you" view. No new data collection, no LLM.
 *
 * Contract under test:
 *   1. External domains are tallied; the tracked domain (and its www.) is excluded.
 *   2. shareOfVoice = (keywords the competitor appears on) / (keywords with SERP data),
 *      avgPosition is the mean of the competitor's best position per keyword, and the list
 *      is ranked by share of voice.
 *   3. "Who outranks you" lists only competitors ABOVE your position; if you do not rank
 *      (position 0), everyone on that SERP outranks you.
 *   4. skipped rows and empty-URL rows carry no competitor.
 *   5. Ownership: a domain not owned by the account returns 403.
 *   6. A keyword set with no SERP data yet returns keywordsAnalyzed 0 and a note.
 *
 * Heavy deps (db, Domain + Keyword models, authorize) are mocked so the handler's
 * tally/attribution logic runs in isolation. Mirrors scoreboard-ai-attribution.test.ts.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/competitor-visibility';
import Keyword from '../../database/models/keyword';

jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));

// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;

/** A DB-row stand-in: the route calls .get({ plain: true }) on each row, then parseKeywords runs. */
const keywordRow = (overrides: Record<string, unknown>) => {
   const plain = {
      ID: 1,
      keyword: 'masset',
      domain: 'getmasset.com',
      device: 'desktop',
      country: 'US',
      position: 1,
      url: 'https://getmasset.com/',
      target_page: '/',
      history: '{}',
      tags: '[]',
      lastResult: '[]',
      lastUpdateError: 'false',
      sticky: false,
      ...overrides,
   };
   return { get: () => plain };
};

const serp = (rows: { position: number, url: string, skipped?: boolean }[]) =>
   JSON.stringify(rows.map((r) => ({ position: r.position, url: r.url, title: '', ...(r.skipped ? { skipped: true } : {}) })));

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
   mockedAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
});

const byDomain = (rows: any[], d: string) => rows.find((r) => r.domain === d);

describe('GET /api/competitor-visibility', () => {
   it('tallies external competitors, excludes the tracked domain, and computes share of voice', async () => {
      // kw1: we rank #2; rival.com #1, other.com #3.
      // kw2: we rank #1; rival.com #2.
      mockedFindAll.mockResolvedValue([
         keywordRow({
            ID: 1,
            keyword: 'kw1',
            position: 2,
            lastResult: serp([
               { position: 1, url: 'https://rival.com/a' },
               { position: 2, url: 'https://www.getmasset.com/' },
               { position: 3, url: 'https://other.com/x' },
            ]),
         }),
         keywordRow({
            ID: 2,
            keyword: 'kw2',
            position: 1,
            lastResult: serp([
               { position: 1, url: 'https://getmasset.com/' },
               { position: 2, url: 'https://rival.com/b' },
            ]),
         }),
      ]);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.keywordsAnalyzed).toBe(2);

      // getmasset.com itself (and its www. variant) must never appear as a competitor.
      expect(byDomain(res.payload.competitors, 'getmasset.com')).toBeUndefined();

      const rival = byDomain(res.payload.competitors, 'rival.com');
      const other = byDomain(res.payload.competitors, 'other.com');
      expect(rival.keywordCount).toBe(2);
      expect(rival.shareOfVoice).toBe(1); // 2 of 2 keywords
      expect(rival.avgPosition).toBe(1.5); // (1 + 2) / 2
      expect(other.keywordCount).toBe(1);
      expect(other.shareOfVoice).toBe(0.5); // 1 of 2

      // Ranked by share of voice: rival (1.0) before other (0.5).
      expect(res.payload.competitors[0].domain).toBe('rival.com');
   });

   it('reports who outranks you per keyword, and everyone outranks you when you do not rank', async () => {
      mockedFindAll.mockResolvedValue([
         // We rank #3 here; rival.com (#1) and other.com (#2) outrank us, behind.com (#4) does not.
         keywordRow({
            ID: 1,
            keyword: 'kw1',
            position: 3,
            lastResult: serp([
               { position: 1, url: 'https://rival.com/a' },
               { position: 2, url: 'https://other.com/x' },
               { position: 3, url: 'https://getmasset.com/' },
               { position: 4, url: 'https://behind.com/y' },
            ]),
         }),
         // We do not rank (position 0): every external domain on the SERP outranks us.
         keywordRow({
            ID: 2,
            keyword: 'kw2',
            position: 0,
            lastResult: serp([
               { position: 1, url: 'https://rival.com/b' },
               { position: 2, url: 'https://other.com/z' },
            ]),
         }),
      ]);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);

      const kw1 = res.payload.outrankedKeywords.find((k: any) => k.keyword === 'kw1');
      const kw2 = res.payload.outrankedKeywords.find((k: any) => k.keyword === 'kw2');

      const kw1Domains = kw1.outrankedBy.map((o: any) => o.domain);
      expect(kw1Domains).toContain('rival.com');
      expect(kw1Domains).toContain('other.com');
      expect(kw1Domains).not.toContain('behind.com'); // ranks below us
      expect(kw1.yourPosition).toBe(3);

      expect(kw2.yourPosition).toBe(0);
      expect(kw2.outrankedBy.map((o: any) => o.domain).sort()).toEqual(['other.com', 'rival.com']);
   });

   it('ignores skipped rows and empty-URL rows', async () => {
      mockedFindAll.mockResolvedValue([
         keywordRow({
            ID: 1,
            keyword: 'kw1',
            position: 2,
            lastResult: serp([
               { position: 1, url: 'https://rival.com/a' },
               { position: 2, url: 'https://getmasset.com/' },
               { position: 3, url: '', skipped: true },
               { position: 4, url: '' },
            ]),
         }),
      ]);

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.competitors.length).toBe(1);
      expect(res.payload.competitors[0].domain).toBe('rival.com');
   });

   it('403s when the domain is not owned by the account', async () => {
      mockedDomainFindOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'notmine.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('returns keywordsAnalyzed 0 and a note when no SERP data is stored yet', async () => {
      mockedFindAll.mockResolvedValue([
         keywordRow({ ID: 1, keyword: 'kw1', position: 0, lastResult: '[]' }),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.keywordsAnalyzed).toBe(0);
      expect(res.payload.competitors).toEqual([]);
      expect(res.payload.note).toContain('No stored SERP results');
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });
});
