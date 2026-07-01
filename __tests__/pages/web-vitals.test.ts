/**
 * web-vitals route: Core Web Vitals report. Verifies p75 computation, Google-threshold
 * classification (good / needs-improvement / poor), per-page worst breakdown, the empty-samples
 * note, human-only default (bot rows are filtered by the query, not here), and ownership 403.
 * Mocks the models, sequelize, and authorize; the real p75 + threshold math runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/web-vitals';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const wv = (label: string, value: number, page: string) => ({ type: 'webvital', label, metric_value: value, page });

const makeReq = (query: Record<string, string>): NextApiRequest => ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

const metricOf = (payload: any, metric: string) => payload.metrics.find((m: any) => m.metric === metric);

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockDomain.findOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
});

describe('GET /api/web-vitals', () => {
   it('computes p75 per metric and classifies it against Google thresholds', async () => {
      // LCP samples: 1000,2000,3000,5000 -> nearest-rank p75 = ceil(0.75*4)=3rd value = 3000ms.
      //   3000 is > good(2500) and <= poor(4000) -> needs-improvement.
      // CLS samples: 0.05, 0.05, 0.05, 0.05 -> p75 = 0.05 <= good(0.1) -> good.
      // INP samples: 600, 700 -> p75 = 700 > poor(500) -> poor.
      mockEvent.findAll.mockResolvedValue([
         wv('LCP', 1000, '/a'), wv('LCP', 2000, '/a'), wv('LCP', 3000, '/b'), wv('LCP', 5000, '/b'),
         wv('CLS', 0.05, '/a'), wv('CLS', 0.05, '/a'), wv('CLS', 0.05, '/b'), wv('CLS', 0.05, '/b'),
         wv('INP', 600, '/a'), wv('INP', 700, '/b'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);
      expect(res.statusCode).toBe(200);

      const lcp = metricOf(res.payload, 'LCP');
      expect(lcp.p75).toBe(3000);
      expect(lcp.rating).toBe('needs-improvement');
      expect(lcp.sampleCount).toBe(4);
      expect(lcp.unit).toBe('ms');

      const cls = metricOf(res.payload, 'CLS');
      expect(cls.p75).toBe(0.05);
      expect(cls.rating).toBe('good');
      expect(cls.unit).toBe('score');

      const inp = metricOf(res.payload, 'INP');
      expect(inp.p75).toBe(700);
      expect(inp.rating).toBe('poor');

      // totalSamples counts every webvital row read.
      expect(res.payload.totalSamples).toBe(10);
      expect(res.payload.note).toBeNull();
   });

   it('returns the worst pages by LCP p75, slowest first', async () => {
      mockEvent.findAll.mockResolvedValue([
         wv('LCP', 1200, '/fast'),
         wv('LCP', 1400, '/fast'),
         wv('LCP', 4800, '/slow'),
         wv('LCP', 5200, '/slow'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.payload.worstPagesMetric).toBe('LCP');
      expect(res.payload.worstPages[0].page).toBe('/slow');
      expect(res.payload.worstPages[0].rating).toBe('poor');
      expect(res.payload.worstPages[1].page).toBe('/fast');
      expect(res.payload.worstPages[1].rating).toBe('good');
   });

   it('returns a clear note and null ratings when there are no webvital samples', async () => {
      mockEvent.findAll.mockResolvedValue([]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.totalSamples).toBe(0);
      expect(res.payload.worstPages).toEqual([]);
      expect(res.payload.worstPagesMetric).toBeNull();
      expect(String(res.payload.note)).toMatch(/no core web vitals samples yet/i);
      // Every metric is present but unmeasured.
      expect(metricOf(res.payload, 'LCP').p75).toBeNull();
      expect(metricOf(res.payload, 'LCP').rating).toBeNull();
   });

   it('falls back to the most-sampled metric for worstPages when LCP has no samples', async () => {
      mockEvent.findAll.mockResolvedValue([
         wv('TTFB', 200, '/a'), wv('TTFB', 300, '/a'), wv('TTFB', 2000, '/b'),
         wv('FCP', 1500, '/a'),
      ]);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.payload.worstPagesMetric).toBe('TTFB');
      expect(res.payload.worstPages[0].page).toBe('/b');
   });

   it('400s when domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(400);
      expect(String(res.payload.error)).toMatch(/domain is required/i);
   });

   it('403s when the domain is not owned by the account', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(403);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      const req = { method: 'POST', query: { domain: 'getmasset.com' }, body: {}, headers: {} } as unknown as NextApiRequest;
      await handler(req, res);
      expect(res.statusCode).toBe(405);
   });
});
