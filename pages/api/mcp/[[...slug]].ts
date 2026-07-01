/**
 * Hosted, remote MCP endpoint for s33k (Streamable HTTP transport).
 *
 * THE POINT: the single user connects to s33k from any MCP client (Claude.ai connectors, Claude Code,
 * Cursor) by adding ONE URL plus their Bearer key (process.env.APIKEY), with NO local install. The
 * local stdio server (mcp/src/index.ts) still exists as an alternative; this route is the zero-install
 * path. It exposes the SAME tools and knowledge resources via the SHARED registerS33kTools
 * (mcp/src/tools.ts), so the two transports can never drift.
 *
 * THE SECURITY CRUX (read before touching this file):
 *   Every tool here calls the s33k REST API carrying ONLY the CONNECTING CLIENT'S Bearer key, never
 *   a server-side or admin key. The route reads `Authorization: Bearer <key>` off the incoming HTTP
 *   request and binds a per-request fetchImpl to THAT key. The s33k API's authorize() then does the
 *   route-whitelist check. There is no code path in which a connection uses anything but its own key.
 *   A request with no Bearer key is rejected 401 before any MCP work happens.
 *
 *   We run in STATELESS mode (sessionIdGenerator: undefined) and build a fresh McpServer +
 *   transport + fetchImpl PER REQUEST, then close them when the response finishes. Nothing
 *   (server, transport, session, or key) is shared across connections, so one client's key can
 *   never bleed into another's request. This is the deliberate choice over a long-lived
 *   session: it makes cross-connection key leakage structurally impossible.
 *
 * Transport: the SDK ships StreamableHTTPServerTransport (Node http flavor) at the installed
 * version (1.29.0). Its handleRequest(req, res, parsedBody) takes a Node IncomingMessage /
 * ServerResponse, which is exactly what the Next pages-router hands us (NextApiRequest extends
 * IncomingMessage, NextApiResponse extends ServerResponse), so we pass them straight through.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
// The SDK's ESM entry points are addressed with the .js extension through its package "exports"
// wildcard (./* -> ./dist/esm/*). Webpack resolves it; the eslint import resolver does not
// understand the wildcard, so the extension/resolution rules are disabled for these two lines only.
// eslint-disable-next-line import/extensions, import/no-unresolved
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// eslint-disable-next-line import/extensions, import/no-unresolved
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// The tool registrations live in the MCP workspace (mcp/src/tools.ts). The root tsconfig EXCLUDES
// mcp/ from type-checking, but webpack still resolves and bundles this relative import for the
// server build, so the same tools are served here without duplicating a single registration.
// eslint-disable-next-line import/no-relative-packages
import { registerS33kTools, FetchImpl } from '../../../mcp/src/tools';
import { ensureSynced } from '../../../database/database';
import { rateLimit } from '../../../utils/rate-limit';

// Resolve the base URL for the internal loopback call to s33k's own REST API. We ALWAYS call the
// same local process (127.0.0.1 on PORT): the API we proxy is OURS and runs in THIS container, so
// there is never a reason to reach another host. We deliberately do NOT derive the host from request
// headers (x-forwarded-host / host). Doing so would let a forged header redirect the loopback fetch,
// which carries the CONNECTING CLIENT'S Bearer key, to an attacker-controlled host: that is Bearer-key
// exfiltration plus SSRF. Keeping this header-independent closes that class entirely, regardless of
// how (or whether) NEXT_PUBLIC_APP_URL is configured. Takes no request on purpose.
export const resolveBaseUrl = (): string => `http://127.0.0.1:${process.env.PORT || 3000}`;

// Extract the raw Bearer key from the incoming request. Returns '' when absent/malformed so the
// handler can reject with 401. We forward this exact key on every underlying API call and nothing
// else: the key IS the connection's identity and scope.
export const extractBearer = (req: NextApiRequest): string => {
   const header = req.headers.authorization;
   if (!header || !header.startsWith('Bearer ')) { return ''; }
   return header.substring('Bearer '.length).trim();
};

// Build the per-request fetchImpl bound to the connecting client's key. Same contract as the stdio
// server's s33kFetch, except the key is the caller's, not the server's. Every tool routes through
// this, so authorize() on the target route enforces the key's scope. No admin/server key is ever
// reachable from here.
export const makeFetchImpl = (baseUrl: string, bearer: string): FetchImpl => async (path, options = {}) => {
   const { method = 'GET', query, body } = options;
   const url = new URL(`${baseUrl}${path}`);
   if (query) {
      for (const [key, value] of Object.entries(query)) {
         if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, value);
         }
      }
   }
   const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
   if (body !== undefined) { headers['Content-Type'] = 'application/json'; }

   const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
   });
   const text = await res.text();
   let parsed: unknown = null;
   try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
   if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' && (parsed as { error?: string }).error
         ? (parsed as { error?: string }).error
         : text;
      throw new Error(`s33k API ${method} ${path} failed (${res.status}): ${detail}`);
   }
   return parsed;
};

// Send a JSON-RPC error envelope. Used for the no-Bearer 401 (id null, since we reject before
// parsing the JSON-RPC message) and any unexpected failure, in the shape MCP clients expect.
const sendJsonRpcError = (res: NextApiResponse, status: number, code: number, message: string): void => {
   res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
   // Cold-start safety net only; migrations run on boot. Cheap awaited no-op after the first call.
   await ensureSynced();

   // SECURITY GATE: no credential, no connection. We reject here, before any MCP server is built, so
   // an unauthenticated request never reaches tool registration or the transport. Single-user: the
   // only valid key is process.env.APIKEY, checked by authorize() on the underlying REST route.
   const bearer = extractBearer(req);
   if (!bearer) {
      sendJsonRpcError(res, 401, -32001, 'Missing Authorization: Bearer <s33k API key>. The hosted s33k MCP requires the API key per connection.');
      return;
   }

   const effectiveKey = bearer;

   // Per-key abuse brake on this surface. The key is held to a generous budget so a runaway client
   // cannot fan out unbounded loopback work (crawls, SERP scrapes) from one connection. Checked AFTER
   // the no-credential rejection so anonymous floods still take the cheaper path.
   const gate = rateLimit(`mcp:${effectiveKey}`, { limit: 240, windowMs: 60000 });
   if (!gate.allowed) {
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000).toString());
      sendJsonRpcError(res, 429, -32002, 'Rate limit exceeded for this key. Slow down and retry shortly.');
      return;
   }

   const baseUrl = resolveBaseUrl();
   const fetchImpl = makeFetchImpl(baseUrl, effectiveKey);

   // Per-request, stateless server + transport. Building these fresh for every request is what makes
   // cross-connection key leakage impossible: this server only ever knows THIS request's key.
   const server = new McpServer({ name: 's33k-mcp', version: '0.1.0' });
   registerS33kTools(server, fetchImpl);

   const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

   // Tear down when the HTTP response finishes, so no per-request server/transport lingers.
   res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
   });

   try {
      await server.connect(transport);
      // Next has already parsed the JSON body (bodyParser default on). Pass it as parsedBody so the
      // transport does not try to re-read the consumed stream. For GET (SSE) req.body is undefined.
      await transport.handleRequest(req, res, req.body);
   } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
         sendJsonRpcError(res, 500, -32603, `Internal MCP error: ${message}`);
      }
   }
}
