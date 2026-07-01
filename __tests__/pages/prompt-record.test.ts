/** prompt-record route: the user's LLM writes back a citation result. Owner-gated, owner-scoped. */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/promptCheck', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/prompt-record';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import PromptCheckModel from '../../database/models/promptCheck';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockPC = PromptCheckModel as unknown as { findOne: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

// A PromptCheck row whose update() captures the patch for assertions.
const pcRow = (data: Record<string, unknown>) => {
   const state = { ...data };
   return {
      get: () => state,
      update: jest.fn(async (patch: Record<string, unknown>) => { Object.assign(state, patch); return undefined; }),
      ...state,
   };
};
const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const makeReq = (body: unknown, method = 'POST'): NextApiRequest =>
   ({ method, body: body || {}, query: {}, headers: {} } as unknown as NextApiRequest);
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

describe('/api/prompt-record', () => {
   it('records a citation result onto the caller\'s own row', async () => {
      const pc = pcRow({ ID: 5, domain: 'getmasset.com', prompt: 'best dam' });
      mockPC.findOne.mockResolvedValue(pc);
      const res = makeRes();
      await handler(makeReq({ id: 5, engine: 'chatgpt', cited: true, position: 2, cited_url: '/software' }), res);
      expect(res.statusCode).toBe(200);
      expect(pc.update).toHaveBeenCalledWith(expect.objectContaining({
         engine: 'chatgpt', cited: true, position: 2, cited_url: '/software',
      }));
      // checked_at is stamped, proving a result entered s33k only via this write-back.
      expect(pc.update.mock.calls[0][0].checked_at).toBeTruthy();
   });

   it('nulls position and cited_url when cited is false', async () => {
      const pc = pcRow({ ID: 5, domain: 'getmasset.com', prompt: 'p' });
      mockPC.findOne.mockResolvedValue(pc);
      const res = makeRes();
      await handler(makeReq({ id: 5, engine: 'claude', cited: false, position: 3, cited_url: '/x' }), res);
      expect(res.statusCode).toBe(200);
      expect(pc.update).toHaveBeenCalledWith(expect.objectContaining({ cited: false, position: null, cited_url: null }));
   });

   it('404s when the row is not found for this account (owner-scoped)', async () => {
      mockPC.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ id: 99, engine: 'chatgpt', cited: true }), res);
      expect(res.statusCode).toBe(404);
   });

   it('403s when the caller does not own the row\'s domain (no update)', async () => {
      const pc = pcRow({ ID: 5, domain: 'someoneelse.com', prompt: 'p' });
      mockPC.findOne.mockResolvedValue(pc);
      mockDomain.findOne.mockResolvedValue(null); // ownership gate fails
      const res = makeRes();
      await handler(makeReq({ id: 5, engine: 'chatgpt', cited: true }), res);
      expect(res.statusCode).toBe(403);
      expect(pc.update).not.toHaveBeenCalled();
   });

   it('400s when no selector (id or domain+prompt) is supplied', async () => {
      const res = makeRes();
      await handler(makeReq({ engine: 'chatgpt', cited: true }), res);
      expect(res.statusCode).toBe(400);
   });

   it('400s when cited is not a boolean', async () => {
      const res = makeRes();
      await handler(makeReq({ id: 5, engine: 'chatgpt', cited: 'yes' }), res);
      expect(res.statusCode).toBe(400);
   });

   it('400s on an unknown engine', async () => {
      const res = makeRes();
      await handler(makeReq({ id: 5, engine: 'bard', cited: true }), res);
      expect(res.statusCode).toBe(400);
   });

   it('400s on a non-integer position', async () => {
      const res = makeRes();
      await handler(makeReq({ id: 5, engine: 'chatgpt', cited: true, position: 1.5 }), res);
      expect(res.statusCode).toBe(400);
   });

   it('405s on a non-POST method', async () => {
      const res = makeRes();
      await handler(makeReq({}, 'GET'), res);
      expect(res.statusCode).toBe(405);
   });
});
