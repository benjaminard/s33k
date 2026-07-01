/**
 * entry-page-report route: per entry page, first-touch sessions broken down by source channel,
 * optional goal conversions, and the tracked keywords/rank whose target page is that entry page.
 * Mocks the models; the real sessionize + entry-page join logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/entry-page-report';
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
const pv = (session: string, source: string, is_bot: boolean, page: string, created: string) =>
   row({ session, source, is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>): NextApiRequest => ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
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
   mockGoal.findOne.mockResolvedValue(row({ ID: 1, name: 'Demo', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix' }));
   // Keywords: /pricing ranks #3 ("pricing") and #8 ("cost"); /ghost ranks #2 but never lands (ranking-without-landing).
   mockKeyword.findAll.mockResolvedValue([
      row({ keyword: 'pricing', position: 3, target_page: '/pricing' }),
      row({ keyword: 'cost', position: 8, target_page: '/pricing' }),
      row({ keyword: 'ghost', position: 2, target_page: '/ghost' }),
   ]);
   // Sessions by entry (landing) page:
   //   A: lands /pricing, organic-search, human, converts (reaches /thanks)
   //   B: lands /pricing, ai, human, no convert
   //   C: lands /blog, direct, human, no convert (landing-without-ranking: /blog has no keyword)
   //   D: lands /pricing, organic-search, BOT, converts (excluded by default)
   mockEvent.findAll.mockResolvedValue([
      pv('A', 'organic-search', false, '/pricing', '2026-06-16T10:00:00Z'),
      pv('A', 'organic-search', false, '/thanks', '2026-06-16T10:01:00Z'),
      pv('B', 'ai', false, '/pricing', '2026-06-16T10:02:00Z'),
      pv('C', 'direct', false, '/blog', '2026-06-16T10:03:00Z'),
      pv('D', 'organic-search', true, '/pricing', '2026-06-16T10:04:00Z'),
      pv('D', 'organic-search', true, '/thanks', '2026-06-16T10:05:00Z'),
   ]);
});

const find = (payload: any, page: string) => payload.report.entryPages.find((e: any) => e.entryPage === page);

describe('GET /api/entry-page-report', () => {
   it('buckets first-touch sessions by entry page with a source breakdown, human-only', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.report.totalEntries).toBe(3); // A, B, C (D is bot, excluded)
      expect(res.payload.botSessionsExcluded).toBe(1);

      const pricing = find(res.payload, '/pricing');
      expect(pricing.entries).toBe(2); // A, B
      expect(pricing.sources['organic-search']).toBe(1); // A
      expect(pricing.sources.ai).toBe(1); // B
      expect(pricing.sources.direct).toBe(0);
   });

   it('attaches tracked keywords (by target page) to the matching entry page, sorted by rank', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const pricing = find(res.payload, '/pricing');
      expect(pricing.trackedKeywords.map((k: any) => k.keyword)).toEqual(['pricing', 'cost']); // #3 before #8
      expect(pricing.trackedKeywords[0].position).toBe(3);
   });

   it('surfaces landing-without-ranking: an entry page with entries but no tracked keywords', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const blog = find(res.payload, '/blog');
      expect(blog.entries).toBe(1);
      expect(blog.trackedKeywords).toEqual([]);
   });

   it('surfaces ranking-without-landing: a ranking page with zero entries still appears', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const ghost = find(res.payload, '/ghost');
      expect(ghost.entries).toBe(0);
      expect(ghost.trackedKeywords[0].keyword).toBe('ghost');
   });

   it('adds conversion columns per entry page when a goal is given', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Demo' }), res);
      expect(res.payload.report.hasGoal).toBe(true);
      const pricing = find(res.payload, '/pricing');
      expect(pricing.conversions).toBe(1); // A converts, B does not
      expect(pricing.conversionRatePct).toBe(50); // 1 of 2
   });

   it('includeBots folds the bot entry back in', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', includeBots: 'true' }), res);
      expect(res.payload.report.totalEntries).toBe(4); // A, B, C, D
      expect(res.payload.botSessionsExcluded).toBe(0);
   });

   it('403s when the domain is not owned by the account', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'notmine.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('404s when a goal is requested but does not exist', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', goal: 'Nope' }), res);
      expect(res.statusCode).toBe(404);
   });
});
