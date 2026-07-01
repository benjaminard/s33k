/**
 * Tests for the hosted MCP HTTP route (pages/api/mcp/[[...slug]].ts).
 *
 * This route is the zero-install remote MCP endpoint. A client connects with a URL plus a Bearer
 * key. The route's job, and the thing these tests pin, is the AUTH + KEY-ISOLATION contract:
 *
 *   1. A request with NO Bearer key is rejected 401 before any MCP server is built. The hosted
 *      endpoint is not anonymously reachable.
 *   2. The per-request fetchImpl carries ONLY the connecting client's key on every underlying API
 *      call, never a server-side or admin key. This is the security crux: the s33k API authorize()
 *      then enforces whatever scope that key has.
 *   3. ensureSynced runs (cold-start schema safety net), matching every other data route.
 *   4. resolveBaseUrl / extractBearer behave as the loopback + auth primitives the route relies on.
 *
 * The full MCP handshake (initialize + tools/list) and the scoped-share-key enforcement proof are
 * driven over a real in-memory MCP client/server in hosted-mcp-scope.test.ts, which exercises the
 * SAME registerS33kTools the route mounts. Here we isolate the HTTP-route concerns and mock the
 * heavy deps (ensureSynced, the MCP transport) so the handler's gate runs in isolation.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

// Mock the DB sync (cold-start net) and the Streamable HTTP transport. We do NOT want a real
// transport touching streams in jsdom; we only need to assert the handler's auth gate and that it
// reaches connect/handleRequest with a server wired to the connecting key (proven via fetchImpl).
jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn().mockResolvedValue(undefined) },
   ensureSynced: jest.fn().mockResolvedValue(undefined),
}));

// resolveAccount (used by the route) type-imports the Account/ApiKey model files (kept on disk as
// type-only single-user dependencies). Loading the real models pulls sequelize (and its ESM
// esm-browser uuid) into jest-jsdom, which jest cannot parse, so stub them out. The route only
// exercises the static-key + 401 behavior here, which never touches these.
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));

// A capturing fake transport: records construction options and resolves handleRequest immediately.
const transportInstances: { options: unknown, handleRequest: jest.Mock, close: jest.Mock }[] = [];
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
   __esModule: true,
   StreamableHTTPServerTransport: jest.fn().mockImplementation((options: unknown) => {
      const inst = {
         options,
         handleRequest: jest.fn().mockResolvedValue(undefined),
         close: jest.fn().mockResolvedValue(undefined),
         // The transport must look like an MCP Transport to server.connect(); these are the methods
         // McpServer.connect touches. Minimal stubs are enough since we assert at the route level.
         start: jest.fn().mockResolvedValue(undefined),
         send: jest.fn().mockResolvedValue(undefined),
         onmessage: undefined,
         onclose: undefined,
         onerror: undefined,
      };
      transportInstances.push(inst);
      return inst;
   }),
}));

// eslint-disable-next-line import/first
import handler, { extractBearer, resolveBaseUrl, makeFetchImpl } from '../../pages/api/mcp/[[...slug]]';
// eslint-disable-next-line import/first
import { ensureSynced } from '../../database/database';

const mockedEnsureSynced = ensureSynced as unknown as jest.Mock;

const makeReq = (over: Partial<NextApiRequest> = {}): NextApiRequest => ({
   method: 'POST',
   query: {},
   headers: {},
   body: undefined,
   ...over,
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = { headersSent: false, _status: 200, _json: undefined };
   res.status = jest.fn().mockImplementation((code: number) => { res._status = code; return res; });
   res.json = jest.fn().mockImplementation((body: unknown) => { res._json = body; res.headersSent = true; return res; });
   res.on = jest.fn();
   res.setHeader = jest.fn();
   res.end = jest.fn();
   return res as unknown as NextApiResponse & { _status: number, _json: any, status: jest.Mock, json: jest.Mock, on: jest.Mock };
};

beforeEach(() => {
   transportInstances.length = 0;
   jest.clearAllMocks();
   delete process.env.NEXT_PUBLIC_APP_URL;
});

describe('hosted MCP route: no Bearer key is rejected 401', () => {
   it('returns 401 with a JSON-RPC error when no Authorization header is present', async () => {
      const req = makeReq({ headers: {} });
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res._json).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
      // No transport is even constructed when auth fails: the gate is before any MCP work.
      expect(transportInstances.length).toBe(0);
   });

   it('returns 401 when the Authorization header is not a Bearer token', async () => {
      const req = makeReq({ headers: { authorization: 'Basic abc123' } });
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(transportInstances.length).toBe(0);
   });

   it('runs ensureSynced even on the rejected path (cold-start safety net always fires)', async () => {
      const req = makeReq({ headers: {} });
      const res = makeRes();
      await handler(req, res);
      expect(mockedEnsureSynced).toHaveBeenCalledTimes(1);
   });
});

describe('hosted MCP route: a valid Bearer key builds a per-request transport in stateless mode', () => {
   it('constructs the transport stateless (sessionIdGenerator undefined) and handles the request', async () => {
      const req = makeReq({ headers: { authorization: 'Bearer s33k_connectingkey' }, body: { jsonrpc: '2.0', method: 'ping', id: 1 } });
      const res = makeRes();
      await handler(req, res);
      // A transport was built per request, in STATELESS mode (no shared session across connections).
      expect(transportInstances.length).toBe(1);
      expect(transportInstances[0].options).toEqual({ sessionIdGenerator: undefined });
      // The request body (already parsed by Next) is forwarded as parsedBody so the transport does
      // not re-read the consumed stream.
      expect(transportInstances[0].handleRequest).toHaveBeenCalledWith(req, res, req.body);
   });
});

describe('extractBearer: pulls exactly the connecting client key', () => {
   it('returns the token after "Bearer "', () => {
      expect(extractBearer(makeReq({ headers: { authorization: 'Bearer s33k_abc' } }))).toBe('s33k_abc');
   });
   it('returns empty for a missing or non-Bearer header (so the route 401s)', () => {
      expect(extractBearer(makeReq({ headers: {} }))).toBe('');
      expect(extractBearer(makeReq({ headers: { authorization: 'Token x' } }))).toBe('');
   });
});

describe('resolveBaseUrl: loopback target is header-independent (no host-header poisoning)', () => {
   const savedPort = process.env.PORT;
   afterEach(() => { if (savedPort === undefined) { delete process.env.PORT; } else { process.env.PORT = savedPort; } });

   it('always targets the local process on PORT, defaulting to 3000', () => {
      delete process.env.PORT;
      expect(resolveBaseUrl()).toBe('http://127.0.0.1:3000');
   });
   it('honors PORT for the loopback target', () => {
      process.env.PORT = '8080';
      expect(resolveBaseUrl()).toBe('http://127.0.0.1:8080');
   });
   it('ignores NEXT_PUBLIC_APP_URL and any forwarded host header (the fix that prevents key exfiltration)', () => {
      process.env.PORT = '3000';
      process.env.NEXT_PUBLIC_APP_URL = 'https://example.com/';
      // resolveBaseUrl takes no request now; a forged x-forwarded-host can never reach it. The
      // loopback always stays on 127.0.0.1 so the connecting key is never sent to another host.
      expect(resolveBaseUrl()).toBe('http://127.0.0.1:3000');
   });
});

describe('makeFetchImpl: every call carries ONLY the connecting client key (the security crux)', () => {
   const realFetch = global.fetch;
   afterEach(() => { global.fetch = realFetch; });

   it('sends Authorization: Bearer <connecting key>, never a server/admin key', async () => {
      const seen: { url: string, headers: Record<string, string> }[] = [];
      global.fetch = jest.fn().mockImplementation(async (url: string, init: any) => {
         seen.push({ url, headers: init.headers });
         return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
      }) as unknown as typeof fetch;

      const fetchImpl = makeFetchImpl('https://app.example.com', 's33k_CONNECTING_KEY');
      await fetchImpl('/api/summary', { query: { domain: 'getmasset.com' } });
      await fetchImpl('/api/keywords', { method: 'POST', body: { keyword: 'x', domain: 'getmasset.com' } });

      expect(seen).toHaveLength(2);
      // Both calls carry the connecting key and nothing else. There is no APIKEY / admin key path.
      expect(seen[0].headers.Authorization).toBe('Bearer s33k_CONNECTING_KEY');
      expect(seen[1].headers.Authorization).toBe('Bearer s33k_CONNECTING_KEY');
      // Query and method are passed through to the real loopback URL.
      expect(seen[0].url).toBe('https://app.example.com/api/summary?domain=getmasset.com');
      expect(seen[1].url).toBe('https://app.example.com/api/keywords');
   });

   it('throws with the API error detail on a non-2xx so the tool surfaces it', async () => {
      global.fetch = jest.fn().mockResolvedValue({
         ok: false,
         status: 403,
         text: async () => JSON.stringify({ error: 'This key is limited to getmasset.com.' }),
      } as unknown as Response) as unknown as typeof fetch;
      const fetchImpl = makeFetchImpl('https://app.example.com', 's33k_scoped');
      await expect(fetchImpl('/api/summary', { query: { domain: 'other.com' } }))
         .rejects.toThrow(/403.*limited to getmasset.com/);
   });
});
