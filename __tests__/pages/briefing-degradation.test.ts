/**
 * Tests for the daily-briefing composer's graceful degradation
 * (pages/api/briefing.ts).
 *
 * The briefing joins every s33k pillar (traffic, human-vs-bot, SEO rank, AI
 * referrals, engagement) into one narration-ready structure. Its
 * hard contract: a single failing sub-signal must NOT break the briefing. Each
 * pillar is fetched independently; a rejection degrades that one section into a
 * note while the rest of the briefing still builds. The only non-200 paths are
 * auth (401) and a missing domain (400).
 *
 * Contract under test:
 *   1. Happy path: all pillars resolve, status 200, a headline, four sections,
 *      and at least one recommendation.
 *   2. A provider method that REJECTS (e.g. getSummary throws) degrades only its
 *      section into an "unavailable" note; status is still 200 and the other
 *      sections are intact.
 *   3. estimateHumanTraffic rejecting does not break the briefing (200).
 *   4. Many sub-signals failing at once still yields a usable 200 briefing.
 *   5. Auth failure returns 401; a missing domain returns 400.
 *
 * All heavy deps (db, Domain, Keyword, authorize, the analytics provider,
 * estimateHumanTraffic) are mocked. No DB, no network, no LLM.
 */

import handler from '../../pages/api/briefing';
import { getAnalyticsProvider } from '../../utils/analytics';
import { estimateHumanTraffic } from '../../utils/bot-filter';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
// Mock sequelize so the route's `Op` import does not drag the real ORM into jest.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
// Mock the first-party events model so the briefing's new sessionize fetch does not
// pull sequelize decorators into jest (same pattern as human-analytics.test.ts).
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});
jest.mock('../../utils/bot-filter', () => ({ __esModule: true, estimateHumanTraffic: jest.fn() }));

import authorize from '../../utils/authorize';
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedKeywordFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedEventFindAll = (S33kEvent as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;
const mockedEstimate = estimateHumanTraffic as jest.Mock;

/** A DB-row stand-in: the route calls .get({ plain: true }) on each keyword row. */
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

/** A minimal Next-style GET req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query, headers: {}, url: '/api/briefing' } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/**
 * Build a provider stub. Each pillar method can be made to throw via the
 * `throwOn` set so we can test per-signal degradation.
 */
const providerStub = (throwOn: Set<string> = new Set()) => {
   const guard = (name: string, value: any) => async () => {
      if (throwOn.has(name)) { throw new Error(`${name} backend exploded`); }
      return value;
   };
   return {
      getPageTraffic: guard('getPageTraffic', {
         pages: [
            { url: 'https://getmasset.com/', pathClean: '/', page_views: 80, unique_visitors: 70, bounce_rate: 40, avg_duration: 30 },
            { url: 'https://getmasset.com/software/mcp', pathClean: '/software/mcp', page_views: 20, unique_visitors: 18, bounce_rate: 50, avg_duration: 25 },
         ],
         error: null,
      }),
      getReferralSources: guard('getReferralSources', {
         sources: [
            { name: 'chatgpt.com', engine: 'ChatGPT', isAI: true, unique_visitors: 5 },
            { name: 'google.com', engine: null, isAI: false, unique_visitors: 40 },
         ],
         error: null,
      }),
      getSummary: guard('getSummary', {
         pageviews: 100, visitors: 88, bounceRate: 45, avgDuration: 120, pagesPerVisit: 1.2, error: null,
      }),
      getEngagement: guard('getEngagement', {
         tiers: [{ label: 'Browsed', percentage: 30 }, { label: 'Bounced', percentage: 70 }],
         error: null,
      }),
   };
};

const goodEstimate = {
   estVisitors: 88, estHumanVisitors: 60, estBotVisitors: 28, botSharePct: 32, method: 'test', error: null,
};

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller (account.ID === 1) and an owned domain, so the route
   // passes auth + the ownership gate and reaches the degradation logic under test.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedKeywordFindAll.mockResolvedValue([
      keywordRow({ ID: 1, keyword: 'masset', target_page: '/', position: 1 }),
      keywordRow({ ID: 2, keyword: 'DAM MCP server', target_page: '/software/mcp', position: 14 }),
   ]);
   mockedEstimate.mockResolvedValue(goodEstimate);
   mockedGetProvider.mockReturnValue(providerStub());
   // Default: no first-party events. The route sessionizes [] and passes an empty
   // array to estimateHumanTraffic, which is mocked above, so the existing
   // degradation cases are unaffected (additive change).
   mockedEventFindAll.mockResolvedValue([]);
});

describe('briefing composer graceful degradation', () => {
   it('builds a full briefing (200, headline, four sections, recommendations) when all pillars resolve', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      expect(typeof captured.body.headline).toBe('string');
      expect(captured.body.headline.length).toBeGreaterThan(0);
      expect(captured.body.sections).toHaveLength(4);
      expect(Array.isArray(captured.body.recommendations)).toBe(true);
      expect(captured.body.recommendations.length).toBeGreaterThan(0);
      expect(captured.body.generatedFor).toEqual({ domain: 'getmasset.com', period: '30d' });
   });

   it('headline is a tight state-of-site line and no longer carries the "Top action:" suffix', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      // The action now lives only in recommendations[], not duplicated into the headline.
      expect(captured.body.headline).not.toMatch(/Top action:/i);
      expect(captured.body.recommendations.length).toBeGreaterThan(0);
   });

   it('degrades only the traffic section (still 200) when getSummary rejects', async () => {
      mockedGetProvider.mockReturnValue(providerStub(new Set(['getSummary'])));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      // All four sections are still present; the traffic one carries the note.
      expect(captured.body.sections).toHaveLength(4);
      const traffic = captured.body.sections.find((s: any) => /human-vs-bot/i.test(s.title));
      expect(traffic.points.join(' ')).toMatch(/unavailable/i);
      // The SEO section is unaffected and still reports the tracked keywords.
      const seo = captured.body.sections.find((s: any) => /Search rank/i.test(s.title));
      expect(seo.points.join(' ')).toMatch(/tracked keywords/i);
   });

   it('does not break the briefing when estimateHumanTraffic rejects', async () => {
      mockedEstimate.mockRejectedValue(new Error('bot-filter backend exploded'));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.sections).toHaveLength(4);
      const traffic = captured.body.sections.find((s: any) => /human-vs-bot/i.test(s.title));
      // The pageview line still rendered (summary resolved); only the bot line degraded.
      expect(traffic.points.join(' ')).toMatch(/pageviews|Human-vs-bot estimate unavailable/i);
   });

   it('still returns a usable 200 briefing when many sub-signals fail at once', async () => {
      mockedGetProvider.mockReturnValue(providerStub(new Set([
         'getPageTraffic', 'getReferralSources', 'getSummary', 'getEngagement',
      ])));
      mockedEstimate.mockRejectedValue(new Error('estimate down'));
      mockedKeywordFindAll.mockRejectedValue(new Error('keyword query down'));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.sections).toHaveLength(4);
      expect(Array.isArray(captured.body.recommendations)).toBe(true);
      expect(captured.body.recommendations.length).toBeGreaterThan(0);
      expect(typeof captured.body.headline).toBe('string');
   });

   it('headline human count reflects the FIRST-PARTY split, not the bot-inflated provider visitor total', async () => {
      // The provider summary reports 724 visitors (bot-inflated). The first-party
      // sessions are the truth: 2 human + 1 bot. The route must sessionize the events,
      // pass them to estimateHumanTraffic, and lead the headline with the human number,
      // not summaryData.visitors. We assert the route forwards the sessionized
      // first-party set as the 4th arg and that the headline uses the resulting human
      // count, by computing the estimate from exactly those sessions in the mock.
      const eventRow = (data: Record<string, unknown>) => ({ get: () => data, ...data });
      const pageview = (session: string, isBot: boolean) => eventRow({
         session, page: '/', is_bot: isBot, created: '2026-06-16T10:00:00.000Z',
         type: 'pageview', source: 'direct', device: 'desktop', country: 'US',
      });
      mockedEventFindAll.mockResolvedValue([
         pageview('A', false), pageview('B', false), pageview('C', true),
      ]);
      mockedGetProvider.mockReturnValue({
         ...providerStub(),
         getSummary: async () => ({ pageviews: 900, visitors: 724, bounceRate: 97, avgDuration: 2, pagesPerVisit: 1.0, error: null }),
      });
      // The mock computes the estimate from the first-party sessions it is HANDED,
      // proving the route forwards them. Falls back to the degraded shape if absent.
      const { firstPartyHumanTraffic } = jest.requireActual('../../utils/bot-filter');
      mockedEstimate.mockImplementation(async (_p: unknown, _d: unknown, _period: unknown, sessions: unknown[]) => {
         if (Array.isArray(sessions) && sessions.length > 0) { return firstPartyHumanTraffic(sessions); }
         return { estVisitors: 0, estHumanVisitors: 0, estBotVisitors: 0, botSharePct: 0, botEstimationAvailable: false, method: '', error: null };
      });

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      // 2 human sessions (A, B), so the headline leads with the human count, not 724.
      expect(captured.body.headline).toMatch(/about 2 human visitor/i);
      expect(captured.body.headline).not.toMatch(/724/);
   });

   it('returns 401 when the request is not authorized', async () => {
      mockedAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'This Route Requires a valid Authorization Bearer Token.' });
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(401);
   });

   it('returns 400 when the domain is missing', async () => {
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);

      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/domain/i);
   });
});
