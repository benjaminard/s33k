/**
 * Behavioral + ownership tests for the executive_summary prebuilt report
 * (pages/api/executive-summary.ts), the leadership one-glance cross-pillar bundle.
 *
 * Why mock the way we do: the route reuses the REAL shared utils (sessionize,
 * attributeConversions, summarizeSeo) on purpose, so they run for real here and the
 * test verifies the genuine join, not a stub of it. Only the I/O edges are mocked:
 * the DB layer, the models, authorize, and the analytics provider. No network, no DB.
 *
 * Single-user: there is one account (the admin sentinel). scopeWhere is always {}, so reads
 * carry no owner_id.
 *
 * Contracts under test:
 *   1. Human-only by default: bot sessions are excluded from humanVisitors and
 *      topChannel.
 *   2. No goal: headline.conversions is null, topConvertingChannel is null, SEO + AI
 *      blocks still answer, and nextAction falls back to an SEO/traffic signal.
 *   3. With a goal: conversions + conversionRatePct populate, topConvertingChannel is
 *      the highest-RATE converting channel, and nextAction is the conversion money
 *      move when an opportunity exists.
 *   4. SEO block: keywordsOnPageOne counts current page-one positions; biggestGain /
 *      biggestLoss come from keyword.history over the period.
 *   5. AI visibility: sendingVisitors + count + topEngine come from AI referral sources.
 *   6. Degrades: empty everything -> 200 with zeroed numbers and an install note;
 *      a referral-provider rejection degrades only the AI block (still 200).
 *   7. Guard rails: missing domain -> 400 (nothing read); non-GET -> 405.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// Stub Op so jest never has to transform sequelize's ESM deps. The models are mocked, so Op is only
// a unique object key inside the findAll where-clause.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// Mock only the analytics PROVIDER edge (the I/O boundary), so we control AI-referral data without a
// real Umami/Lodd call. The rest of utils/analytics (types) is irrelevant at runtime here.
const mockGetReferralSources = jest.fn();
jest.mock('../../utils/analytics', () => ({
   __esModule: true,
   getAnalyticsProvider: () => ({ getReferralSources: mockGetReferralSources }),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/executive-summary';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
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

// Models return instances with .get({ plain: true }); wrap a plain row to mimic that.
const plain = (obj: Record<string, unknown>) => ({ get: () => obj });

// A first-party event row as findAll returns it (pre-.get wrapping done by eventRows()).
const ev = (over: Partial<EventRow>): EventRow => ({
   session: 's1', source: 'direct', is_bot: false, device: 'desktop', country: 'US',
   page: '/', type: 'pageview', created: new Date().toJSON(), ...over,
});
type EventRow = {
   session: string, source: string | null, is_bot: boolean, device: string | null,
   country: string | null, page: string, type: string, created: string,
};

const eventRows = (rows: EventRow[]) => rows.map(plain);
const keywordRows = (rows: Array<Record<string, unknown>>) => rows.map(plain);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   // Default: no AI referrals, no provider error. Tests override as needed.
   mockGetReferralSources.mockResolvedValue({ sources: [], error: null });
   // Sensible empties so a test that does not care about a pillar still gets a 200.
   mockKeyword.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/executive-summary: no-goal summary', () => {
   it('human-only headline + top channel, null conversions, and an SEO/AI healthLine', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      // 2 organic-search human sessions, 1 direct human session, 1 bot session (must be excluded).
      mockEvent.findAll.mockResolvedValue(eventRows([
         ev({ session: 'h1', source: 'organic-search' }),
         ev({ session: 'h2', source: 'organic-search' }),
         ev({ session: 'h3', source: 'direct' }),
         ev({ session: 'b1', source: 'organic-search', is_bot: true }),
      ]));
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com', period: '30d' }), res);

      expect(res.statusCode).toBe(200);
      const b = res.payload;
      // Bot excluded: 3 human visitors, not 4.
      expect((b.headline as { humanVisitors: number }).humanVisitors).toBe(3);
      expect((b.headline as { conversions: number | null }).conversions).toBeNull();
      expect((b.headline as { conversionRatePct: number | null }).conversionRatePct).toBeNull();
      expect(b.topChannel).toEqual({ channel: 'organic-search', sessions: 2 });
      expect(b.topConvertingChannel).toBeNull();
      expect(typeof b.healthLine).toBe('string');
      expect(typeof b.nextAction).toBe('string');
   });

   it('SEO block: page-one count from current positions, biggest gain/loss from history', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      mockEvent.findAll.mockResolvedValue(eventRows([ev({ session: 'h1', source: 'direct' })]));
      // gainer climbed 18 -> 6 (delta +12, the biggest gain). slipper fell 4 -> 14 (delta -10, the
      // biggest loss). steady has only one point (no move). Two are on page one now (6 and 4... wait,
      // slipper's CURRENT position is 14, so only gainer at 6 plus steady at 3 are page-one).
      mockKeyword.findAll.mockResolvedValue(keywordRows([
         { keyword: 'gainer', position: 6, target_page: '', history: JSON.stringify({ '2026-05-20': 18, '2026-06-14': 6 }) },
         { keyword: 'slipper', position: 14, target_page: '', history: JSON.stringify({ '2026-05-20': 4, '2026-06-14': 14 }) },
         { keyword: 'steady', position: 3, target_page: '', history: JSON.stringify({ '2026-06-14': 3 }) },
      ]));
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com', period: '30d' }), res);

      const seo = res.payload.seo as {
         trackedKeywords: number, keywordsOnPageOne: number,
         biggestGain: { keyword: string, delta: number } | null,
         biggestLoss: { keyword: string, delta: number } | null,
      };
      expect(seo.trackedKeywords).toBe(3);
      expect(seo.keywordsOnPageOne).toBe(2); // gainer #6 and steady #3
      expect(seo.biggestGain).toMatchObject({ keyword: 'gainer', delta: 12 });
      expect(seo.biggestLoss).toMatchObject({ keyword: 'slipper', delta: -10 });
   });

   it('AI visibility yes/no + count + top engine from referral sources', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      mockEvent.findAll.mockResolvedValue(eventRows([ev({ session: 'h1', source: 'direct' })]));
      mockGetReferralSources.mockResolvedValue({
         sources: [
            { name: 'chatgpt.com', engine: 'ChatGPT', isAI: true, unique_visitors: 9 },
            { name: 'perplexity.ai', engine: 'Perplexity', isAI: true, unique_visitors: 4 },
            { name: 'news.example', engine: null, isAI: false, unique_visitors: 50 },
         ],
         error: null,
      });
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com' }), res);

      expect(res.payload.aiVisibility).toEqual({ sendingVisitors: true, visitors: 13, topEngine: 'ChatGPT' });
   });
});

describe('GET /api/executive-summary: with a goal', () => {
   const goalRow = plain({ ID: 5, name: 'Demo Booked', kind: 'page_reached', match_value: '/thanks', match_page: null, match_mode: 'prefix' });

   it('populates conversions, top converting channel, and a conversion money-move next action', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      mockGoal.findOne.mockResolvedValue(goalRow);
      // AI: 1 session, converts (lands on /thanks). organic-search: 2 sessions, neither converts.
      // So AI converts at 100%, organic at 0%: AI is the top converting channel, and the
      // ai-outconverts-search opportunity should drive the next action (>= 2 ai sessions needed for
      // that specific opp, so give AI two sessions, one converting).
      mockEvent.findAll.mockResolvedValue(eventRows([
         ev({ session: 'a1', source: 'ai', page: '/thanks' }),
         ev({ session: 'a2', source: 'ai', page: '/pricing' }),
         ev({ session: 'o1', source: 'organic-search', page: '/pricing' }),
         ev({ session: 'o2', source: 'organic-search', page: '/pricing' }),
      ]));
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com', goal: 'Demo Booked' }), res);

      expect(res.statusCode).toBe(200);
      const b = res.payload;
      expect(b.goal).toEqual({ id: 5, name: 'Demo Booked' });
      const h = b.headline as { conversions: number, conversionRatePct: number };
      expect(h.conversions).toBe(1);
      expect(h.conversionRatePct).toBe(25); // 1 of 4 human sessions
      // AI converts at 50% (1 of 2), organic at 0%: AI is the top converting channel.
      expect((b.topConvertingChannel as { channel: string }).channel).toBe('ai');
      // nextAction is the conversion opportunity (the AI-outconverts-search money move).
      expect(b.nextAction).toMatch(/AI-search visitors convert/);
   });

   it('goal lookup is scoped by domain and id', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: null });
      mockGoal.findOne.mockResolvedValue(goalRow);
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com', goalId: '5' }), res);

      expect(mockGoal.findOne.mock.calls[0][0].where).toMatchObject({ domain: 'a.com', ID: 5 });
   });
});

describe('GET /api/executive-summary: degrade + guard rails', () => {
   it('empty everything: 200 with zeroed numbers and an install note', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      const b = res.payload;
      expect((b.headline as { humanVisitors: number }).humanVisitors).toBe(0);
      expect(b.topChannel).toBeNull();
      expect((b.aiVisibility as { sendingVisitors: boolean }).sendingVisitors).toBe(false);
      expect(b.note).toMatch(/tracking script/i);
      expect(b.nextAction).toMatch(/Install the s33k.js tracking script/);
      expect(b.error).toBeNull();
   });

   it('degrades the AI block (still 200) when the referral provider rejects', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      mockEvent.findAll.mockResolvedValue(eventRows([ev({ session: 'h1', source: 'direct' })]));
      mockGetReferralSources.mockRejectedValue(new Error('provider down'));
      const res = makeRes();

      await handler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      const b = res.payload;
      expect((b.aiVisibility as { sendingVisitors: boolean }).sendingVisitors).toBe(false);
      // Traffic still answered, and the note explains the AI gap rather than failing the summary.
      expect((b.headline as { humanVisitors: number }).humanVisitors).toBe(1);
      expect(b.note).toMatch(/AI-referral data was unavailable/);
   });

   it('400s when domain is missing and reads nothing', async () => {
      asCaller(ADMIN);
      const res = makeRes();

      await handler(makeReq({}), res);

      expect(res.statusCode).toBe(400);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockEvent.findAll).not.toHaveBeenCalled();
   });

   it('405s a non-GET method', async () => {
      asCaller(ADMIN);
      const res = makeRes();

      await handler(makeReq({}, 'POST'), res);

      expect(res.statusCode).toBe(405);
   });
});
