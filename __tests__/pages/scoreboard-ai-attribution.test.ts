/**
 * Tests for the page_scoreboard AI-referral attribution path
 * (pages/api/scoreboard.ts).
 *
 * The scoreboard joins per-page traffic to tracked keywords and tries to
 * attribute AI-engine-referred visitors to the page they landed on. That last
 * step depends on whether the analytics provider reports a per-source
 * landing_path. The contract under test is that AI attribution must DEGRADE
 * GRACEFULLY and never break the scoreboard:
 *
 *   1. When AI sources carry landing_path, visitors are attributed to the right
 *      page (matched by clean path) and aiReferralNote is null.
 *   2. When AI sources have no landing_path, every page reports
 *      aiReferralVisitors: 0 and aiReferralNote explains why (still HTTP 200).
 *   3. When getReferralSources throws, the route catches it, sets referralError,
 *      keeps aiReferralVisitors: 0, and still returns the full scoreboard (200),
 *      never a 500.
 *   4. When getReferralSources returns an error string (no landing detail), that
 *      error is surfaced as referralError and attribution stays at 0.
 *
 * The route's heavy dependencies (db, the Domain and Keyword models, authorize) are mocked
 * so the test exercises the handler's join/attribution logic in isolation.
 */

import handler from '../../pages/api/scoreboard';
import { getAnalyticsProvider } from '../../utils/analytics';
import Keyword from '../../database/models/keyword';

// scoreboard.ts now imports the Domain model (for the multi-tenant ownership check),
// which transitively pulls sequelize. Stub sequelize so jest does not transform its
// ESM uuid dependency, and mock Domain.findOne to a resolved owned row.
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

import authorize from '../../utils/authorize';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedEventFindAll = (S33kEvent as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

/** A DB-row stand-in: the route calls .get({ plain: true }) on each row. */
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

/** A minimal Next-style req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/** Build a provider stub with controllable page traffic and referral behavior. */
const providerStub = (opts: {
   pages: any[],
   referral?: { sources?: any[], error?: string | null },
   referralThrows?: boolean,
}) => ({
   getPageTraffic: jest.fn(async () => ({ pages: opts.pages, error: null })),
   getReferralSources: jest.fn(async () => {
      if (opts.referralThrows) { throw new Error('referral backend exploded'); }
      return { sources: opts.referral?.sources ?? [], error: opts.referral?.error ?? null };
   }),
});

const pageRow = (over: Record<string, unknown> = {}) => ({
   url: 'https://getmasset.com/',
   pathClean: '/',
   page_views: 100,
   unique_visitors: 90,
   bounce_rate: 40,
   avg_duration: 30,
   ...over,
});

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller (account.ID === 1) and an owned domain, so the route
   // passes auth + the ownership gate and reaches the attribution logic under test.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/' })]);
   // Default: NO first-party events, so these AI-attribution cases exercise the provider fallback
   // exactly as before (the existing assertions about provider landing_path still hold).
   mockedEventFindAll.mockResolvedValue([]);
});

describe('scoreboard AI-referral attribution', () => {
   it('attributes AI-referred visitors to the right page when landing_path is present', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         pages: [pageRow({ pathClean: '/', page_views: 100 })],
         referral: {
            sources: [
               { name: 'chatgpt.com', type: 'ai', engine: 'ChatGPT', isAI: true, unique_visitors: 7, landing_path: '/' },
               { name: 'google.com', type: 'search', engine: null, isAI: false, unique_visitors: 50, landing_path: '/' },
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toBeNull();
      expect(captured.body.aiReferralNote).toBeNull();
      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      // Only the AI source (7) is attributed, not the non-AI search source (50).
      expect(home.aiReferralVisitors).toBe(7);
   });

   it('reports 0 AI visitors and an explanatory note when no source carries landing_path', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         pages: [pageRow({ pathClean: '/', page_views: 100 })],
         referral: {
            // AI sources exist but are reported site-wide (no landing_path).
            sources: [{ name: 'ChatGPT', type: 'ai', engine: 'ChatGPT', isAI: true, unique_visitors: 12 }],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      expect(home.aiReferralVisitors).toBe(0);
      expect(captured.body.aiReferralNote).toMatch(/no per-landing-page detail/i);
   });

   it('never 500s when the referral fetch throws; it returns the scoreboard with referralError set', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         pages: [pageRow({ pathClean: '/', page_views: 100 })],
         referralThrows: true,
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      // The scoreboard still builds: 200, the page is present, attribution is 0.
      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toMatch(/exploded/i);
      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      expect(home).toBeDefined();
      expect(home.aiReferralVisitors).toBe(0);
      // The note still explains the absence of per-page AI detail.
      expect(captured.body.aiReferralNote).toMatch(/no per-landing-page detail/i);
   });

   it('surfaces a provider referral error string and keeps attribution at 0', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         pages: [pageRow({ pathClean: '/', page_views: 100 })],
         referral: { sources: [], error: 'Referral query failed' },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toBe('Referral query failed');
      const home = captured.body.scoreboard.find((p: any) => p.pathClean === '/');
      expect(home.aiReferralVisitors).toBe(0);
   });

   it('matches landing_path to a page by clean path even when the source path has a trailing slash or query', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 9, keyword: 'mcp', target_page: '/software/mcp' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         pages: [pageRow({ url: 'https://getmasset.com/software/mcp', pathClean: '/software/mcp', page_views: 30 })],
         referral: {
            sources: [
               // Trailing slash + query string must normalize to /software/mcp.
               { name: 'perplexity.ai', type: 'ai', engine: 'Perplexity', isAI: true, unique_visitors: 4, landing_path: '/software/mcp/?utm=ai' },
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const mcp = captured.body.scoreboard.find((p: any) => p.pathClean === '/software/mcp');
      expect(mcp.aiReferralVisitors).toBe(4);
      expect(captured.body.aiReferralNote).toBeNull();
   });
});
