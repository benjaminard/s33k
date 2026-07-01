/**
 * Tests for the AI-referrals route (pages/api/ai-referrals.ts).
 *
 * ai_referrals reports which AI engines actually SENT visitors to a domain, read
 * from the analytics provider's classified referral sources, never querying an LLM.
 * The contract under test, exercised through the handler with its heavy deps mocked:
 *
 *   1. byEngine rows are { engine, visitors } ONLY. Per-engine pageViews is NOT
 *      surfaced: the Umami provider cannot return a per-referrer pageview count, so
 *      a surfaced value would always be 0, a false number (a visitor implies at
 *      least one pageview). The real Umami ReferralSource shape has NO page_views.
 *   2. AI sources aggregate per engine; non-AI sources are excluded from byEngine
 *      but counted in the share denominator.
 *   3. Ownership 403 and the GET guard.
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
import handler from '../../pages/api/ai-referrals';
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

/**
 * An AI ReferralSource stand-in matching the REAL Umami provider shape: isAI true,
 * unique_visitors present, and NO page_views field (Umami cannot supply it).
 */
const refRow = (over: Record<string, unknown> = {}) => ({
   name: 'chatgpt.com',
   type: 'ai',
   engine: 'ChatGPT',
   isAI: true,
   unique_visitors: 5,
   ...over,
});

/** Build a provider stub from referral sources. */
const providerStub = (sources: any[] = []) => ({
   getReferralSources: jest.fn(async () => ({ sources, error: null })),
});

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller and an owned domain so the route reaches the read.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedGetProvider.mockReturnValue(providerStub([]));
});

describe('ai_referrals: guards and ownership', () => {
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

describe('ai_referrals: byEngine surface', () => {
   it('aggregates AI sources per engine as { engine, visitors } and never surfaces pageViews', async () => {
      // Real Umami shape: NO page_views on any source.
      mockedGetProvider.mockReturnValue(providerStub([
         refRow({ engine: 'ChatGPT', unique_visitors: 9 }),
         refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 3 }),
         { name: 'google.com', type: 'search', engine: null, isAI: false, unique_visitors: 8 },
      ]));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const { byEngine, totals } = captured.body;
      // Non-AI google.com is excluded from byEngine but counted in the denominator.
      expect(byEngine.map((e: any) => e.engine)).toEqual(['ChatGPT', 'Perplexity']);
      expect(byEngine[0]).toEqual({ engine: 'ChatGPT', visitors: 9 });
      // The misleading always-0 pageViews aggregate must be gone entirely.
      expect(byEngine[0]).not.toHaveProperty('pageViews');
      expect(byEngine[1]).not.toHaveProperty('pageViews');
      expect(totals.aiVisitors).toBe(12);
      expect(totals.allVisitors).toBe(20);
      expect(totals.aiSharePct).toBe(60);
   });
});
