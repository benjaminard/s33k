/**
 * causal-links route: the cross-pillar over-time join. Mocks the models; the real sessionize +
 * computeCausalLinks logic runs. Covers the happy path (a classification fires end to end through the
 * route, including old + ISO history keys in one history), the honest not-enough-history note, and the
 * tenancy/method gates (403 unowned, 400 no domain, 405 non-GET, and a scoped/owner gate path).
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/causal-links';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const pv = (session: string, page: string, created: string) =>
   row({ session, source: 'organic-search', is_bot: false, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>, method = 'GET'): NextApiRequest =>
   ({ method, query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   // The fixtures use fixed June-2026 dates but the route windows from Date.now() (its single clock
   // read). Pin the clock inside the fixture era, or the suite is a time bomb: it first went red on
   // 2026-07-06, when the 30d window slid past the earliest fixture session.
   jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-20T12:00:00Z').getTime());
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   // Keyword targets /pricing; history mixes the OLD non-padded key and the new ISO key, a rank gain.
   mockKeyword.findAll.mockResolvedValue([
      row({ keyword: 'saas pricing', position: 4, history: JSON.stringify({ '2026-6-3': 18, '2026-06-10': 4 }), target_page: '/pricing' }),
   ]);
   // Sessions on /pricing: low before the rank change, high after, so rank-gain-drove-traffic fires.
   const sessions: any[] = [];
   ['2026-06-05', '2026-06-07', '2026-06-09'].forEach((d, i) => sessions.push(pv(`b${i}`, '/pricing', `${d}T12:00:00Z`)));
   ['2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16'].forEach(
      (d, i) => sessions.push(pv(`a${i}`, '/pricing', `${d}T12:00:00Z`)),
   );
   mockEvent.findAll.mockResolvedValue(sessions);
});

afterAll(() => {
   jest.restoreAllMocks();
});

describe('GET /api/causal-links', () => {
   it('correlates a rank gain with a traffic rise end to end, parsing old + ISO history keys', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.error).toBeNull();
      expect(Array.isArray(res.payload.links)).toBe(true);
      expect(res.payload.links).toHaveLength(1);
      const link = res.payload.links[0];
      expect(link.classification).toBe('rank-gain-drove-traffic');
      // Both history keys parsed: the change is dated to the ISO-keyed later day.
      expect(link.rankFrom).toBe(18);
      expect(link.rankTo).toBe(4);
      expect(link.rankChangeDate).toBe('2026-06-10');
      // Correlation framing present, never a causation claim.
      expect(link.evidence.note.toLowerCase()).toContain('likely');
      expect(res.payload.note.toLowerCase()).toContain('correlation');
   });

   it('returns the honest not-enough-history note (no fabricated link) when history is too thin', async () => {
      mockKeyword.findAll.mockResolvedValue([
         row({ keyword: 'new term', position: 5, history: JSON.stringify({ '2026-06-10': 5 }), target_page: '/pricing' }),
      ]);
      mockEvent.findAll.mockResolvedValue([pv('x', '/pricing', '2026-06-10T12:00:00Z')]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.links).toHaveLength(0);
      expect(res.payload.note.toLowerCase()).toContain('not enough history');
   });

   it('403s when the caller does not own the domain (tenancy gate before any read)', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someone-elses.com' }), res);
      expect(res.statusCode).toBe(403);
      // The pillar reads must NOT have run once ownership failed.
      expect(mockKeyword.findAll).not.toHaveBeenCalled();
      expect(mockEvent.findAll).not.toHaveBeenCalled();
   });

   it('400s when no domain is supplied', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }, 'POST'), res);
      expect(res.statusCode).toBe(405);
   });

   it('401s when authorize denies', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'no key' });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(401);
   });
});
