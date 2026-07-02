/**
 * Route-level tests for the keyword WRITE contract (POST/PUT /api/keywords in pages/api/keywords.ts).
 *
 * Two LLM-ergonomics defects are pinned here:
 *
 * 1. target_page is a schema-documented argument, so it must either WORK or be REJECTED, never
 *    silently drop. POST stores it (trimmed, exactly as the PUT path stores it, so the
 *    page_scoreboard join behaves identically) and echoes it back; a non-string is rejected 400
 *    on both POST and PUT.
 *
 * 2. Write responses are COMPACT. The stored lastResult is a 100-position SERP array of which
 *    ~90 rows are empty skipped placeholders; echoing it per keyword is zero-information noise
 *    for a caller who asked to set a target page or sticky flag. The PUT/POST responses now carry
 *    serpTop (top 3 real results) + serpResultCount instead of lastResult. Storage is untouched.
 *
 * The DB models, auth, refresh, settings, and Search Console reads are mocked; parseKeywords and
 * the serp-compact shaping run for real so the response shape is genuinely exercised.
 */

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findAll: jest.fn(), findOne: jest.fn(), count: jest.fn() },
}));
jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: { bulkCreate: jest.fn(), count: jest.fn(async () => 0), update: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn(async () => ({ authorized: true, account: null })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
jest.mock('../../utils/scraper', () => ({ __esModule: true, removeFromRetryQueue: jest.fn(async () => undefined) }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper', scaping_api: 'k' })) }));
jest.mock('../../utils/adwords', () => ({ __esModule: true, getKeywordsVolume: jest.fn(), updateKeywordsVolumeData: jest.fn() }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   readLocalSCData: jest.fn(async () => false),
   integrateKeywordSCData: jest.fn((k: unknown) => k),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/keywords';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as {
   bulkCreate: jest.Mock, count: jest.Mock, update: jest.Mock, findAll: jest.Mock,
};

const makeReq = (opts: { method?: string, body?: unknown, query?: Record<string, string> } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body || {},
   query: opts.query || {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn().mockImplementation((body: unknown) => { res.body = body; return res; });
   res.setHeader = jest.fn();
   return res as unknown as NextApiResponse & { statusCode: number, body: any };
};

/** A stored keyword row: 100-position lastResult with only 10 real (non-skipped) entries. */
const storedKeywordRow = (over: Record<string, unknown> = {}) => {
   const lastResult = Array.from({ length: 100 }, (_, i) => (
      i < 10
         ? { position: i + 1, url: `https://example.com/r${i + 1}`, title: `Result ${i + 1}` }
         : { position: i + 1, url: '', title: '', skipped: true }
   ));
   const data = {
      ID: 42,
      keyword: 'example keyword',
      device: 'desktop',
      country: 'US',
      domain: 'example.com',
      lastUpdated: '2026-07-01T00:00:00.000Z',
      added: '2026-07-01T00:00:00.000Z',
      position: 1,
      volume: 0,
      sticky: false,
      history: JSON.stringify({ '2026-07-01': 1 }),
      lastResult: JSON.stringify(lastResult),
      url: 'https://example.com/r1',
      tags: JSON.stringify([]),
      updating: false,
      lastUpdateError: 'false',
      target_page: '/old',
      owner_id: null,
      ...over,
   };
   return { get: () => data };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   mockDomain.findAll.mockResolvedValue([{ domain: 'example.com' }]);
   mockKeyword.count.mockResolvedValue(0);
   mockKeyword.bulkCreate.mockImplementation(async (rows: Record<string, unknown>[]) => rows.map((r) => ({ get: () => r })));
   mockKeyword.update.mockResolvedValue([1]);
   mockKeyword.findAll.mockResolvedValue([storedKeywordRow()]);
});

describe('POST /api/keywords: target_page works or is rejected, never silently dropped', () => {
   it('stores a provided target_page (trimmed, like the PUT path) and echoes it in the response', async () => {
      const res = makeRes();
      await handler(makeReq({
         body: { keywords: [{ keyword: 'foo', domain: 'example.com', country: 'US', device: 'desktop', target_page: ' /pricing ' }] },
      }), res);
      expect(res.statusCode).toBe(201);
      // The insert carries the trimmed value.
      expect(mockKeyword.bulkCreate.mock.calls[0][0][0].target_page).toBe('/pricing');
      // The response echoes what was stored.
      expect(res.body.keywords[0].target_page).toBe('/pricing');
   });

   it('still works without target_page (stores the empty string)', async () => {
      const res = makeRes();
      await handler(makeReq({
         body: { keywords: [{ keyword: 'foo', domain: 'example.com', country: 'US', device: 'desktop' }] },
      }), res);
      expect(res.statusCode).toBe(201);
      expect(mockKeyword.bulkCreate.mock.calls[0][0][0].target_page).toBe('');
      expect(res.body.keywords[0].target_page).toBe('');
   });

   it('rejects a non-string target_page with 400 instead of coercing it', async () => {
      const res = makeRes();
      await handler(makeReq({
         body: { keywords: [{ keyword: 'foo', domain: 'example.com', country: 'US', device: 'desktop', target_page: 123 }] },
      }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('target_page');
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
   });

   it('the create response is compact: serpTop + serpResultCount, no lastResult echo', async () => {
      const res = makeRes();
      await handler(makeReq({
         body: { keywords: [{ keyword: 'foo', domain: 'example.com', country: 'US', device: 'desktop', target_page: '/p' }] },
      }), res);
      const kw = res.body.keywords[0];
      expect(kw).not.toHaveProperty('lastResult');
      expect(kw.serpTop).toEqual([]);
      expect(kw.serpResultCount).toBe(0);
   });
});

describe('PUT /api/keywords: compact response, no 100-position SERP echo', () => {
   it('setting target_page stores the trimmed value and returns serpTop (max 3, no skipped rows) without lastResult', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'PUT', query: { id: '42' }, body: { target_page: ' /new ' } }), res);
      expect(res.statusCode).toBe(200);
      expect(mockKeyword.update).toHaveBeenCalledWith({ target_page: '/new' }, expect.anything());

      const kw = res.body.keywords[0];
      expect(kw).not.toHaveProperty('lastResult');
      expect(kw.serpTop).toEqual([
         { position: 1, url: 'https://example.com/r1', title: 'Result 1' },
         { position: 2, url: 'https://example.com/r2', title: 'Result 2' },
         { position: 3, url: 'https://example.com/r3', title: 'Result 3' },
      ]);
      // 10 real entries were stored; the other 90 skipped placeholders never count.
      expect(kw.serpResultCount).toBe(10);
      // The rest of the keyword row survives untouched.
      expect(kw.ID).toBe(42);
      expect(kw.history).toEqual({ '2026-07-01': 1 });
   });

   it('toggling sticky returns the same compact shape', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'PUT', query: { id: '42' }, body: { sticky: true } }), res);
      expect(res.statusCode).toBe(200);
      expect(mockKeyword.update).toHaveBeenCalledWith({ sticky: true }, expect.anything());
      expect(res.body.keywords[0]).not.toHaveProperty('lastResult');
      expect(res.body.keywords[0].serpResultCount).toBe(10);
   });

   it('rejects a non-string target_page with 400', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'PUT', query: { id: '42' }, body: { target_page: 7 } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('target_page');
      expect(mockKeyword.update).not.toHaveBeenCalled();
   });

   it('rejects an empty update payload with 400 (the old always-false guard is fixed)', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'PUT', query: { id: '42' }, body: {} }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('keyword Payload Missing!');
   });
});

describe('GET /api/keywords: read path is byte-identical (lastResult stays an emptied array)', () => {
   it('list responses keep their existing shape, including target_page and the emptied lastResult', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'GET', query: { domain: 'example.com' } }), res);
      expect(res.statusCode).toBe(200);
      const kw = res.body.keywords[0];
      expect(kw.target_page).toBe('/old');
      expect(kw.lastResult).toEqual([]);
      expect(kw).not.toHaveProperty('serpTop');
   });
});
