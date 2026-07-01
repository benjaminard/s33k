/** prompt-checks route: track (owner-gated write), list (owner-gated read), delete (owner-scoped). */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/promptCheck', () => ({
   __esModule: true, default: { create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/prompt-checks';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import PromptCheckModel from '../../database/models/promptCheck';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockPC = PromptCheckModel as unknown as { create: jest.Mock, findAll: jest.Mock, findOne: jest.Mock, destroy: jest.Mock };
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
   mockPC.findOne.mockResolvedValue(null);
});

describe('/api/prompt-checks', () => {
   it('tracks a prompt when the caller owns the domain (created with NO result)', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      mockPC.create.mockResolvedValue(row({ ID: 5, domain: 'getmasset.com', prompt: 'best dam', cited: null }));
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com', prompt: 'best dam' } }), res);
      expect(res.statusCode).toBe(201);
      // Created with all result fields null (s33k stores the prompt only; no engine queried).
      expect(mockPC.create).toHaveBeenCalledWith(expect.objectContaining({
         prompt: 'best dam', engine: null, cited: null, position: null, cited_url: null, checked_at: null,
      }));
   });

   it('canonicalizes the domain on track so it joins to the canonical rows', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      mockPC.create.mockResolvedValue(row({ ID: 5 }));
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'HTTPS://WWW.getmasset.com/', prompt: 'x' } }), res);
      expect(res.statusCode).toBe(201);
      expect(mockPC.create).toHaveBeenCalledWith(expect.objectContaining({ domain: 'getmasset.com' }));
   });

   it('403s tracking a prompt on an unowned domain (no create)', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'someoneelse.com', prompt: 'x' } }), res);
      expect(res.statusCode).toBe(403);
      expect(mockPC.create).not.toHaveBeenCalled();
   });

   it('400s when domain or prompt is missing', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com' } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockPC.create).not.toHaveBeenCalled();
   });

   it('409s tracking a duplicate prompt for the same domain (no create)', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      mockPC.findOne.mockResolvedValue(row({ ID: 9, prompt: 'best dam' }));
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com', prompt: 'best dam' } }), res);
      expect(res.statusCode).toBe(409);
      expect(mockPC.create).not.toHaveBeenCalled();
   });

   it('403s listing prompts for an unowned domain (no read)', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ method: 'GET', query: { domain: 'someoneelse.com' } }), res);
      expect(res.statusCode).toBe(403);
      expect(mockPC.findAll).not.toHaveBeenCalled();
   });

   it('lists a domain\'s tracked prompts when owned', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      mockPC.findAll.mockResolvedValue([row({ ID: 1, prompt: 'a' }), row({ ID: 2, prompt: 'b' })]);
      const res = makeRes();
      await handler(makeReq({ method: 'GET', query: { domain: 'getmasset.com' } }), res);
      expect(res.payload.promptChecks).toHaveLength(2);
   });

   it('400s listing without a domain', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'GET', query: {} }), res);
      expect(res.statusCode).toBe(400);
   });

   it('deletes a tracked prompt by id (owner-scoped)', async () => {
      mockPC.destroy.mockResolvedValue(1);
      const res = makeRes();
      await handler(makeReq({ method: 'DELETE', query: { id: '5' } }), res);
      expect(res.payload.removed).toBe(1);
   });

   it('405s on an unsupported method', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'PUT' }), res);
      expect(res.statusCode).toBe(405);
   });
});
