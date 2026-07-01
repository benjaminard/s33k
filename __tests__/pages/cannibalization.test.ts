/**
 * cannibalization route: flags the clear cases where Google cannot decide which of a domain's pages
 * should rank for a term. Mocks the models + authorize; the real findCannibalization logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/cannibalization';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
// position, ranking url (stored as JSON array), and target_page.
const kw = (keyword: string, position: number, url: string, targetPage: string) =>
   row({ keyword, position, url: JSON.stringify([url]), target_page: targetPage });

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
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
});

const byType = (payload: any, type: string) => payload.groups.filter((g: any) => g.type === type);

describe('GET /api/cannibalization', () => {
   it('(a) flags intent split: keyword ranks on a url different from its target page', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // Ranks on /blog/dam but target is /dam -> intent split.
         kw('ai-ready dam', 6, 'https://getmasset.com/blog/dam', 'https://getmasset.com/dam'),
         // Ranks on its own target page -> healthy, no flag.
         kw('dam mcp server', 4, 'https://getmasset.com/mcp', 'https://getmasset.com/mcp'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      const split = byType(res.payload, 'intent_split');
      expect(split).toHaveLength(1);
      expect(split[0].keywords).toEqual(['ai-ready dam']);
      expect(split[0].urls).toContain('https://getmasset.com/blog/dam');
      expect(split[0].urls).toContain('https://getmasset.com/dam');
   });

   it('treats http/https, trailing slash, and query string as the same page (no false intent split)', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // Ranking url and target differ only by protocol + trailing slash + query -> same page, no flag.
         kw('dam', 3, 'http://getmasset.com/dam/?utm=x', 'https://getmasset.com/dam'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.payload.total).toBe(0);
   });

   it('treats an absolute ranking url and a relative target_page for the SAME page as healthy (no false intent split)', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // The real-world shape: SerpBear stores the ranking url ABSOLUTE while target_page is RELATIVE.
         // Same page, so it must NOT flag. Regression guard for the host-not-stripped false positive
         // that flagged every keyword ranking on its own page.
         kw('openai codex for marketers', 2,
            'https://www.getmasset.com/resources/blog/openai-codex-sites-for-marketers',
            '/resources/blog/openai-codex-sites-for-marketers'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.payload.total).toBe(0);
      expect(byType(res.payload, 'intent_split')).toHaveLength(0);
   });

   it('still flags intent split when an absolute ranking url and a relative target_page are DIFFERENT paths', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // Absolute ranking url, relative target, genuinely different paths -> real intent split.
         kw('ai-ready dam', 6, 'https://www.getmasset.com/blog/dam', '/dam'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(byType(res.payload, 'intent_split')).toHaveLength(1);
   });

   it('(b) flags shared ranking url across distinct keywords targeting different pages', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // Two keywords both rank on /hub but target different pages -> shared_url conflict.
         kw('highspot alternative', 8, 'https://getmasset.com/hub', 'https://getmasset.com/highspot'),
         kw('seismic alternative', 9, 'https://getmasset.com/hub', 'https://getmasset.com/seismic'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const shared = byType(res.payload, 'shared_url');
      expect(shared).toHaveLength(1);
      expect(shared[0].keywords).toEqual(expect.arrayContaining(['highspot alternative', 'seismic alternative']));
   });

   it('does NOT flag shared url when the keywords share the same target page (healthy)', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // Both rank on /dam and both target /dam -> one page legitimately owns both, no flag.
         kw('dam', 2, 'https://getmasset.com/dam', 'https://getmasset.com/dam'),
         kw('digital asset management', 3, 'https://getmasset.com/dam', 'https://getmasset.com/dam'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(byType(res.payload, 'shared_url')).toHaveLength(0);
   });

   it('(c) flags near-duplicate terms ranking on different urls', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // "DAM software" and "software DAM" normalize to the same word-set, different urls -> duplicate_term.
         kw('DAM software', 5, 'https://getmasset.com/a', 'https://getmasset.com/a'),
         kw('software DAM', 7, 'https://getmasset.com/b', 'https://getmasset.com/b'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      const dup = byType(res.payload, 'duplicate_term');
      expect(dup).toHaveLength(1);
      expect(dup[0].urls).toEqual(expect.arrayContaining(['https://getmasset.com/a', 'https://getmasset.com/b']));
   });

   it('ignores keywords with no live rank (position 0, outside top 100)', async () => {
      mockKeyword.findAll.mockResolvedValue([
         // Not ranking -> cannot cannibalize anything, even though url != target.
         kw('not ranking', 0, 'https://getmasset.com/x', 'https://getmasset.com/y'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.payload.total).toBe(0);
   });

   it('returns an empty list with a friendly note when no conflicts exist', async () => {
      mockKeyword.findAll.mockResolvedValue([
         kw('masset', 1, 'https://getmasset.com/', 'https://getmasset.com/'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.total).toBe(0);
      expect(res.payload.groups).toEqual([]);
      expect(res.payload.note).toContain('No clear keyword cannibalization');
   });

   it('403s when the caller does not own the domain', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
   });
});
