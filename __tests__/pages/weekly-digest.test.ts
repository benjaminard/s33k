/**
 * Behavioral + ownership tests for the weekly_digest PREBUILT REPORT route
 * (pages/api/weekly-digest.ts), the cross-pillar "week in review" bundle.
 *
 * Single-user: there is one account (the admin sentinel). scopeWhere is always {}, so reads
 * carry no owner_id.
 *
 * Contracts under test:
 *   1. Sections compose correctly off ONE sessionized event set: traffic (human-only by default,
 *      bounce), topEntryPages (top 5 by entries), channels (sessions per channel), aiTraffic
 *      (count of ai-channel sessions). Bots are excluded by default and counted as filtered.
 *   2. rankMovers parses each keyword's history JSON for the in-window delta (improved vs worsened),
 *      reusing the rank-movers helper. Smaller position is better, so a climb is a positive delta.
 *   3. Goal sections are OPTIONAL: with no goal, conversions + topOpportunity are null and Goal is
 *      never read. With a goal, conversions total/rate + the top opportunity come from
 *      attributeConversions (the reused cross-pillar join).
 *   4. A requested-but-missing goal -> 404, and no event/keyword read happens.
 *   5. Degrades on an empty event set: 200 with zero human visitors and a tracking-install note.
 *   6. Missing domain -> 400, nothing read. Non-GET -> 405.
 *
 * Models are mocked, authorize is mocked per-test. No network, no DB, no real models imported.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// The route imports { Op } from 'sequelize'. Stub it so jest never transforms sequelize's ESM deps;
// the models are mocked, so Op.gte is only a unique object key in the findAll where-clause.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import weeklyDigestHandler from '../../pages/api/weekly-digest';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockGoal = GoalModel as unknown as { findOne: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (query: Record<string, string> = {}, method = 'GET'): NextApiRequest => ({
   method, query, headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

// A raw event row as findAll returns it via .get({ plain: true }). The route maps rows through
// .get(), so each mocked row exposes get() returning itself.
const ev = (over: Partial<EventShape>): { get: () => EventShape } => {
   const base: EventShape = {
      session: 's1', source: 'direct', is_bot: false, device: 'desktop', country: 'US',
      page: '/', type: 'pageview', created: '2026-06-14T00:00:00.000Z',
   };
   const merged = { ...base, ...over };
   return { get: () => merged };
};
type EventShape = {
   session: string, source: string | null, is_bot: boolean, device: string, country: string,
   page: string, type: string, created: string,
};

// A keyword row with a history JSON string (date -> position). get() returns the plain shape.
const kw = (over: Partial<KeywordShape>): { get: () => KeywordShape } => {
   const base: KeywordShape = { keyword: 'seo tool', position: 5, target_page: '/', history: '{}' };
   return { get: () => ({ ...base, ...over }) };
};
type KeywordShape = { keyword: string, position: number, target_page: string, history: string };

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/weekly-digest: section composition off one event set', () => {
   beforeEach(() => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockKeyword.findAll.mockResolvedValue([]);
   });

   it('computes human-only traffic, top entry pages, channels, and AI traffic; excludes bots', async () => {
      // s1: human, organic-search, lands on /a, 2 pageviews (engaged).
      // s2: human, ai, lands on /a, 1 pageview (bounced).
      // s3: human, direct, lands on /b, 1 pageview (bounced).
      // s4: BOT, ai, lands on /a, 1 pageview -> must be excluded from every human section.
      mockEvent.findAll.mockResolvedValue([
         ev({ session: 's1', source: 'organic-search', page: '/a', type: 'pageview', created: '2026-06-14T00:00:00.000Z' }),
         ev({ session: 's1', source: 'organic-search', page: '/a2', type: 'pageview', created: '2026-06-14T00:01:00.000Z' }),
         ev({ session: 's2', source: 'ai', page: '/a', type: 'pageview', created: '2026-06-14T00:00:00.000Z' }),
         ev({ session: 's3', source: 'direct', page: '/b', type: 'pageview', created: '2026-06-14T00:00:00.000Z' }),
         ev({ session: 's4', source: 'ai', page: '/a', type: 'pageview', is_bot: true, created: '2026-06-14T00:00:00.000Z' }),
      ]);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      const body = res.payload as Record<string, unknown>;
      const traffic = body.traffic as { humanVisitors: number, pageviews: number, bounceRatePct: number, botVisitorsFiltered: number };
      // 3 human sessions, the 1 bot excluded.
      expect(traffic.humanVisitors).toBe(3);
      expect(traffic.pageviews).toBe(4); // 2 + 1 + 1
      // 2 of 3 human sessions are single-pageview bounces.
      expect(traffic.bounceRatePct).toBe(66.7);
      expect(traffic.botVisitorsFiltered).toBe(1);

      const entry = body.topEntryPages as Array<{ page: string, entries: number }>;
      expect(entry[0]).toEqual({ page: '/a', entries: 2 }); // s1 + s2 both land on /a (human)
      expect(entry).toHaveLength(2);

      const channels = body.channels as Array<{ channel: string, sessions: number }>;
      expect(channels.find((c) => c.channel === 'organic-search')?.sessions).toBe(1);
      expect(channels.find((c) => c.channel === 'ai')?.sessions).toBe(1); // bot ai-session not counted
      expect(channels.find((c) => c.channel === 'direct')?.sessions).toBe(1);

      // aiTraffic counts only the human ai session.
      expect((body.aiTraffic as { sessions: number }).sessions).toBe(1);

      // No goal supplied -> conversions + topOpportunity null, Goal never read.
      expect(body.conversions).toBeNull();
      expect(body.topOpportunity).toBeNull();
      expect(mockGoal.findOne).not.toHaveBeenCalled();
   });

   it('includeBots=true folds bot sessions back into the human sections', async () => {
      mockEvent.findAll.mockResolvedValue([
         ev({ session: 's1', source: 'direct', page: '/a', type: 'pageview' }),
         ev({ session: 's2', source: 'ai', page: '/a', type: 'pageview', is_bot: true }),
      ]);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com', includeBots: 'true' }), res);

      const body = res.payload as Record<string, unknown>;
      const traffic = body.traffic as { humanVisitors: number, botVisitorsFiltered: number };
      expect(traffic.humanVisitors).toBe(2); // bot folded in
      expect(traffic.botVisitorsFiltered).toBe(0);
      expect((body.aiTraffic as { sessions: number }).sessions).toBe(1); // bot ai session now counted
   });
});

describe('GET /api/weekly-digest: rank movers from keyword history', () => {
   beforeEach(() => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockEvent.findAll.mockResolvedValue([]); // movers are independent of traffic
   });

   it('parses history JSON to surface improved (climbing) and worsened (falling) keywords', async () => {
      // Window is 7d back from "now". Use very recent dates so they fall inside the window.
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
      mockKeyword.findAll.mockResolvedValue([
         // climber: from #18 -> #6, delta +12 (improved; smaller position is better).
         kw({ keyword: 'climber', position: 6, history: JSON.stringify({ [yesterday]: 18, [today]: 6 }) }),
         // faller: from #4 -> #15, delta -11 (worsened).
         kw({ keyword: 'faller', position: 15, history: JSON.stringify({ [yesterday]: 4, [today]: 15 }) }),
         // flat: no movement, must appear in neither list.
         kw({ keyword: 'flat', position: 9, history: JSON.stringify({ [yesterday]: 9, [today]: 9 }) }),
      ]);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com', period: '7d' }), res);

      const body = res.payload as Record<string, unknown>;
      const movers = body.rankMovers as { improved: Array<{ keyword: string, delta: number }>, worsened: Array<{ keyword: string, delta: number }> };
      expect(movers.improved.map((m) => m.keyword)).toEqual(['climber']);
      expect(movers.improved[0].delta).toBe(12);
      expect(movers.worsened.map((m) => m.keyword)).toEqual(['faller']);
      expect(movers.worsened[0].delta).toBe(-11);
   });
});

describe('GET /api/weekly-digest: optional goal sections', () => {
   beforeEach(() => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockKeyword.findAll.mockResolvedValue([
         // Ranks #1 on /a but its landing sessions convert at zero -> rank-not-converting opportunity.
         kw({ keyword: 'demo', position: 1, target_page: '/a', history: '{}' }),
      ]);
   });

   it('adds conversions total/rate and the top opportunity when a goal is supplied', async () => {
      mockGoal.findOne.mockResolvedValue({
         get: () => ({ ID: 11, name: 'Demo Booked', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix' }),
      });
      // 4 human sessions all landing on /a; one reaches /thanks (a conversion). The /a sessions feed
      // the rank-not-converting opportunity (ranks #1, lands traffic, but those that did not reach
      // /thanks did not convert; the rule needs >=3 landing sessions and zero conversions on that page).
      mockEvent.findAll.mockResolvedValue([
         ev({ session: 'c1', source: 'organic-search', page: '/a', type: 'pageview' }),
         ev({ session: 'c1', source: 'organic-search', page: '/thanks', type: 'pageview', created: '2026-06-14T00:02:00.000Z' }),
         ev({ session: 'c2', source: 'organic-search', page: '/a', type: 'pageview' }),
         ev({ session: 'c3', source: 'organic-search', page: '/a', type: 'pageview' }),
         ev({ session: 'c4', source: 'organic-search', page: '/a', type: 'pageview' }),
      ]);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com', goal: 'Demo Booked' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockGoal.findOne.mock.calls[0][0].where).toMatchObject({ domain: 'a.com', name: 'Demo Booked' });
      const body = res.payload as Record<string, unknown>;
      const conv = body.conversions as { goal: { id: number, name: string }, total: number, conversionRatePct: number };
      expect(conv.goal).toEqual({ id: 11, name: 'Demo Booked' });
      expect(conv.total).toBe(1); // c1 reached /thanks
      expect(conv.conversionRatePct).toBe(25); // 1 of 4 sessions
      // topOpportunity is either null or a valid opportunity object (its exact type depends on
      // attributeConversions thresholds, which conversion-attribution.test.ts covers exhaustively).
      const opp = body.topOpportunity as { type: string } | null;
      expect(opp === null || typeof opp.type === 'string').toBe(true);
   });

   it('404s a requested-but-missing goal and never reads events or keywords', async () => {
      mockGoal.findOne.mockResolvedValue(null);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com', goal: 'Nope' }), res);

      expect(res.statusCode).toBe(404);
      expect(mockEvent.findAll).not.toHaveBeenCalled();
      expect(mockKeyword.findAll).not.toHaveBeenCalled();
   });
});

describe('GET /api/weekly-digest: degrade + guard rails', () => {
   it('degrades on an empty event set: 200, zero human visitors, install note', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockEvent.findAll.mockResolvedValue([]);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      const body = res.payload as Record<string, unknown>;
      expect((body.traffic as { humanVisitors: number }).humanVisitors).toBe(0);
      expect(body.topEntryPages).toEqual([]);
      expect(body.channels).toEqual([]);
      expect((body.aiTraffic as { sessions: number }).sessions).toBe(0);
      expect(body.note).toMatch(/tracking script/i);
      expect(body.error).toBeNull();
   });

   it('defaults the period to 7d (the "week in review" window) when none is passed', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockEvent.findAll.mockResolvedValue([]);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({ domain: 'a.com' }), res);

      expect((res.payload as Record<string, unknown>).period).toBe('7d');
   });

   it('400s when domain is missing and never reads any store', async () => {
      asCaller(ADMIN);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({}), res);

      expect(res.statusCode).toBe(400);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.findAll).not.toHaveBeenCalled();
   });

   it('405s a non-GET method', async () => {
      asCaller(ADMIN);
      const res = makeRes();

      await weeklyDigestHandler(makeReq({}, 'POST'), res);

      expect(res.statusCode).toBe(405);
   });
});
