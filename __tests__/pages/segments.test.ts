/** segments route: create (ownership-gated, filter-normalized), list, delete. */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/segment', () => ({ __esModule: true, default: { create: jest.fn(), findAll: jest.fn(), destroy: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/segments';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import SegmentModel from '../../database/models/segment';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockSegment = SegmentModel as unknown as { create: jest.Mock, findAll: jest.Mock, destroy: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const makeReq = (o: { method: string, body?: unknown, query?: Record<string, string> }): NextApiRequest =>
   ({ method: o.method, body: o.body || {}, query: o.query || {}, headers: {} } as unknown as NextApiRequest);
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
});

describe('/api/segments', () => {
   it('creates a segment when the caller owns the domain, normalizing the filter spec', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      // Echo back what create was called with so we can assert the stored filters string.
      mockSegment.create.mockImplementation(async (vals: Record<string, unknown>) => row({ ID: 7, ...vals }));
      const res = makeRes();
      await handler(makeReq({
         method: 'POST',
         body: { domain: 'getmasset.com', name: 'AI human converters', filters: { channel: 'aio', humanOnly: true, junk: 'drop me' } },
      }), res);
      expect(res.statusCode).toBe(201);
      expect(mockSegment.create).toHaveBeenCalled();
      // channel alias "aio" normalizes to "ai"; junk key is dropped; humanOnly preserved.
      const stored = JSON.parse(mockSegment.create.mock.calls[0][0].filters);
      expect(stored).toEqual({ channel: 'ai', humanOnly: true });
      // Response returns filters parsed back to an object.
      expect(res.payload.segment.name).toBe('AI human converters');
      expect(res.payload.segment.filters).toEqual({ channel: 'ai', humanOnly: true });
   });

   it('403s creating a segment on an unowned domain (no create)', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'someoneelse.com', name: 'X', filters: { channel: 'ai' } } }), res);
      expect(res.statusCode).toBe(403);
      expect(mockSegment.create).not.toHaveBeenCalled();
   });

   it('400s when name or domain is missing', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com', filters: { channel: 'ai' } } }), res);
      expect(res.statusCode).toBe(400);
   });

   it('400s when the filter spec has no known keys', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com', name: 'Empty', filters: { junk: 'x' } } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockSegment.create).not.toHaveBeenCalled();
   });

   it('lists segments for a domain, parsing stored filters to objects', async () => {
      mockSegment.findAll.mockResolvedValue([
         row({ ID: 1, name: 'AI human', filters: '{"channel":"ai","humanOnly":true}' }),
         row({ ID: 2, name: 'Mobile', filters: '{"device":"mobile"}' }),
      ]);
      const res = makeRes();
      await handler(makeReq({ method: 'GET', query: { domain: 'getmasset.com' } }), res);
      expect(res.payload.segments).toHaveLength(2);
      expect(res.payload.segments[0].filters).toEqual({ channel: 'ai', humanOnly: true });
      expect(res.payload.segments[1].filters).toEqual({ device: 'mobile' });
   });

   it('deletes a segment by id', async () => {
      mockSegment.destroy.mockResolvedValue(1);
      const res = makeRes();
      await handler(makeReq({ method: 'DELETE', query: { id: '7' } }), res);
      expect(res.payload.removed).toBe(1);
   });
});
