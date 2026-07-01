/**
 * Tests for the AI Visibility synthesis (pages/api/ai-visibility.ts).
 *
 * AI Visibility is measured from one first-party signal s33k already collects,
 * never querying an LLM: AI REFERRALS (analytics referrals: which engines actually
 * SEND traffic, and to which pages). The contract under test is the synthesis math
 * and the graceful degradation, exercised through the handler with its heavy deps
 * mocked:
 *
 *   1. Summary math: totalAIReferrals and topAdvocate.
 *   2. Per-PAGE status from the referral landing: ai-cited (a referral landed on
 *      the page) or not-cited.
 *   3. Per-ENGINE status: advocate (refers) or absent.
 *   4. Graceful degradation: a thrown referral read and empty inputs each return
 *      200 with the view intact (never a 500), with the referralError field set.
 *   5. Site-wide referrals (no landing_path): engine-level referrals and totals
 *      stay accurate, per-page citation is not attributed, and a note explains it.
 *   6. The citability audit (utils/citability-audit.ts) runs only when referral
 *      data is thin; it is mocked here and covered in its own suite.
 *
 * Non-AI referral sources are filtered upstream, so the route only ever sees AI
 * rows. db, the Domain model, authorize, and the analytics provider are all mocked:
 * no DB, no network.
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
// The optional enrichment fetches real pages; stub it so the synthesis stays pure.
// Its own behavior is covered in __tests__/utils/citability-audit.test.ts.
jest.mock('../../utils/citability-audit', () => ({
   __esModule: true,
   auditCitability: jest.fn(async () => ({ audited: true, pages: [], domainScore: 0, llmsTxtFound: false, note: 'stub' })),
}));

// eslint-disable-next-line import/first
import handler from '../../pages/api/ai-visibility';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';
// eslint-disable-next-line import/first
import { auditCitability } from '../../utils/citability-audit';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;
const mockedAuditCitability = auditCitability as unknown as jest.Mock;

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

/** An AI ReferralSource stand-in. isAI is true by default (the route keeps AI only). */
const refRow = (over: Record<string, unknown> = {}) => ({
   name: 'chatgpt.com',
   type: 'ai',
   engine: 'ChatGPT',
   isAI: true,
   unique_visitors: 5,
   ...over,
});

/** Build a provider stub from referral sources. */
const providerStub = (opts: { referral?: { sources?: any[], error?: string | null }, referralThrows?: boolean }) => ({
   getReferralSources: jest.fn(async () => {
      if (opts.referralThrows) { throw new Error('referral backend exploded'); }
      return { sources: opts.referral?.sources ?? [], error: opts.referral?.error ?? null };
   }),
});

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller and an owned domain so the route reaches the synthesis.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));
});

describe('AI Visibility: math + status classification', () => {
   it('classifies a page that received an AI referral as ai-cited and the engine as an advocate', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 9, landing_path: '/pricing' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const pricing = captured.body.pages.find((p: any) => p.path === '/pricing');
      expect(pricing.isCited).toBe(true);
      expect(pricing.status).toBe('ai-cited');
      expect(pricing.aiReferralVisitors).toBe(9);

      const chatgpt = captured.body.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.status).toBe('advocate');
      expect(chatgpt.referrals).toBe(9);
   });

   it('reports totalAIReferrals across engines', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         referral: {
            sources: [
               refRow({ engine: 'ChatGPT', unique_visitors: 4, landing_path: '/a' }),
               refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 2, landing_path: '/b' }),
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.totalAIReferrals).toBe(6);
   });

   it('picks the advocate with the most referrals as topAdvocate', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         referral: {
            sources: [
               refRow({ engine: 'ChatGPT', unique_visitors: 10, landing_path: '/x' }),
               refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 2, landing_path: '/x' }),
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.topAdvocate).toBe('ChatGPT');
   });
});

describe('AI Visibility: graceful degradation', () => {
   it('never 500s when the referral read throws; returns 200 with referralError set', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ referralThrows: true }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toMatch(/exploded/i);
      expect(captured.body.summary.totalAIReferrals).toBe(0);
   });

   it('returns an empty-but-valid view (200) when there are no referrals', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.pages).toEqual([]);
      expect(captured.body.engines).toEqual([]);
      expect(captured.body.summary).toEqual({
         totalAIReferrals: 0,
         topAdvocate: null,
      });
   });

   it('surfaces a provider referral error string without failing the view', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [], error: 'Not supported by this provider' } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toBe('Not supported by this provider');
   });
});

describe('AI Visibility: site-wide referrals (no per-landing-page detail)', () => {
   it('keeps engine-level referrals and totals accurate but does not attribute per-page citation, with a note', async () => {
      // The AI referral has NO landing_path (site-wide reporting).
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 12 })] }, // no landing_path
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralLandingAvailable).toBe(false);
      // Engine-level referral total is still correct.
      const chatgpt = captured.body.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.referrals).toBe(12);
      expect(captured.body.summary.totalAIReferrals).toBe(12);
      // No page can be marked cited without a landing path.
      expect(captured.body.pages).toEqual([]);
      expect(captured.body.note).toMatch(/site-wide/i);
   });
});

describe('AI Visibility: optional citability enrichment trigger', () => {
   it('runs the citability audit only when first-party AI data is thin (no referrals)', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.dataIsThin).toBe(true);
      expect(mockedAuditCitability).toHaveBeenCalledTimes(1);
      expect(captured.body.citabilityAudit).not.toBeNull();
      expect(captured.body.note).toMatch(/thin/i);
   });

   it('skips the citability audit when first-party AI data is healthy', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 8, landing_path: '/x' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.dataIsThin).toBe(false);
      expect(mockedAuditCitability).not.toHaveBeenCalled();
      expect(captured.body.citabilityAudit).toBeNull();
   });

   it('does not let a thrown citability audit break the view (still 200)', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));
      mockedAuditCitability.mockRejectedValueOnce(new Error('audit fetch exploded'));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.dataIsThin).toBe(true);
      // The audit failed, so it degrades to null rather than throwing.
      expect(captured.body.citabilityAudit).toBeNull();
   });
});
