/**
 * Tests for the prebuilt AEO snapshot report (pages/api/aeo-report.ts).
 *
 * aeo_report BUNDLES the first-party AI-referral signal into one sectioned
 * response, never querying an LLM: AI REFERRALS (which AI engines sent visitors,
 * from the analytics provider's classified referral sources), plus a per-engine
 * ENGINE SUMMARY (referral visitors per engine + the top advocate). The contract
 * under test, exercised through the handler with its heavy deps mocked:
 *
 *   1. aiReferrals: AI sources aggregate per engine; aiSharePct is AI visitors
 *      over ALL referred visitors (AI + non-AI), so non-AI sources count in the
 *      denominator but not the byEngine list.
 *   2. engineSummary: per-engine referral totals, status (advocate / absent),
 *      totalAIReferrals, topAdvocate.
 *   3. note: thin-data honesty (no referrals).
 *   4. Graceful degradation: a thrown referral read returns 200 with referralError
 *      set (never a 500). Ownership 403 and the GET guard.
 *
 * db, the Domain model, authorize, and the analytics provider are all mocked: no
 * DB, no network.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
// analytics -> firstparty-provider imports the s33kEvent sequelize model and Op transitively;
// mock both so jest never transforms sequelize ESM (the route never queries the model directly here).
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

// eslint-disable-next-line import/first
import handler from '../../pages/api/aeo-report';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

/** A minimal Next-style req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>, method = 'GET') => {
   const req = { method, query } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/** An AI ReferralSource stand-in. isAI is true by default. */
const refRow = (over: Record<string, unknown> = {}) => ({
   name: 'chatgpt.com',
   type: 'ai',
   engine: 'ChatGPT',
   isAI: true,
   unique_visitors: 5,
   ...over,
});

/** Build a provider stub from referral sources, optionally throwing. */
const providerStub = (opts: { sources?: any[], error?: string | null, throws?: boolean } = {}) => ({
   getReferralSources: jest.fn(async () => {
      if (opts.throws) { throw new Error('referral backend exploded'); }
      return { sources: opts.sources ?? [], error: opts.error ?? null };
   }),
});

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller and an owned domain so the route reaches the report.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
});

describe('aeo_report: guards and ownership', () => {
   it('returns 405 for a non-GET method', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' }, 'POST');
      await handler(req, res);
      expect(captured.status).toBe(405);
   });

   it('returns 401 when authorize fails', async () => {
      mockedAuthorize.mockResolvedValue({ authorized: false, error: 'no key' });
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(401);
   });

   it('returns 400 when the domain is missing', async () => {
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);
      expect(captured.status).toBe(400);
   });

   it('returns 403 when the caller does not own the domain', async () => {
      mockedDomainFindOne.mockResolvedValue(null);
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(403);
   });
});

describe('aeo_report: aiReferrals section', () => {
   it('aggregates AI sources per engine and computes aiSharePct over ALL referred visitors', async () => {
      // 9 + 3 AI visitors (ChatGPT, Perplexity) over 12 + 8 = 20 total referred -> 60%.
      mockedGetProvider.mockReturnValue(providerStub({
         sources: [
            refRow({ engine: 'ChatGPT', unique_visitors: 9, page_views: 11 }),
            refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 3 }),
            { name: 'google.com', type: 'search', engine: null, isAI: false, unique_visitors: 8 },
         ],
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const { byEngine, totals } = captured.body.aiReferrals;
      // Non-AI google.com is excluded from byEngine but counted in the denominator.
      expect(byEngine.map((e: any) => e.engine)).toEqual(['ChatGPT', 'Perplexity']);
      // pageViews is intentionally NOT surfaced: Umami cannot return a per-referrer
      // pageview count, so it would always be 0, a false value.
      expect(byEngine[0]).toEqual({ engine: 'ChatGPT', visitors: 9 });
      expect(byEngine[0]).not.toHaveProperty('pageViews');
      expect(totals.aiVisitors).toBe(12);
      expect(totals.allReferredVisitors).toBe(20);
      expect(totals.aiSharePct).toBe(60);
   });

   it('reports aiSharePct 0 (no divide-by-zero) when there are no referred visitors', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.aiReferrals.totals).toEqual({ aiVisitors: 0, allReferredVisitors: 0, aiSharePct: 0 });
   });
});

describe('aeo_report: engineSummary section', () => {
   it('reports per-engine referral totals, status, topAdvocate, and totalAIReferrals', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         sources: [
            refRow({ engine: 'ChatGPT', unique_visitors: 10 }),
            refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 2 }),
         ],
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const { engineSummary } = captured.body;
      expect(engineSummary.totalAIReferrals).toBe(12);
      expect(engineSummary.topAdvocate).toBe('ChatGPT');
      const chatgpt = engineSummary.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.status).toBe('advocate');
      expect(chatgpt.referrals).toBe(10);
   });
});

describe('aeo_report: notes and degradation', () => {
   it('sets a thin-data note when there are no AI referrals', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.note).toMatch(/thin/i);
      expect(captured.body.engineSummary.topAdvocate).toBeNull();
   });

   it('never 500s when the referral read throws: returns 200 with referralError set', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ throws: true }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toMatch(/exploded/i);
      expect(captured.body.aiReferrals.totals.aiVisitors).toBe(0);
   });
});
