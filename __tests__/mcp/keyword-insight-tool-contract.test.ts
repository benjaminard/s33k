/**
 * MCP-layer contract tests for the LLM-ergonomics fixes, driven over a REAL SDK client/server
 * pair (InMemoryTransport), so the full tools/call path (schema validation included) is exercised,
 * not just the handler function.
 *
 * Pinned here:
 *   1. add_keyword FORWARDS target_page into the POST /api/keywords body. A schema-documented
 *      argument must reach the route; this is the regression guard for the silently-dropped-arg
 *      class of defect.
 *   2. update_keyword forwards target_page in the PUT body with the ids in the query.
 *   3. get_insight forwards its new limit/detail params as query params, and sends neither when
 *      omitted (the bounded default).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerS33kTools, FetchImpl } from '../../mcp/src/tools';

type RecordedCall = { path: string, options?: { method?: string, query?: Record<string, string>, body?: unknown } };

const setup = async () => {
   const calls: RecordedCall[] = [];
   const fetchImpl: FetchImpl = async (path, options) => {
      calls.push({ path, options });
      return { keywords: [{ ID: 1 }], data: {} };
   };
   const server = new McpServer({ name: 'contract-test', version: '0.0.0' });
   registerS33kTools(server, fetchImpl);
   const client = new Client({ name: 'contract-test-client', version: '0.0.0' });
   const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
   await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
   return { calls, client, close: async () => { await client.close(); await server.close(); } };
};

describe('MCP tool contract: schema-documented arguments reach the API', () => {
   it('add_keyword forwards target_page into the POST body (never silently drops it)', async () => {
      const { calls, client, close } = await setup();
      try {
         const result = await client.callTool({
            name: 'add_keyword',
            arguments: { keyword: 'foo', domain: 'example.com', target_page: '/pricing' },
         });
         expect((result as { isError?: boolean }).isError).toBeFalsy();
         expect(calls).toHaveLength(1);
         expect(calls[0].path).toBe('/api/keywords');
         expect(calls[0].options?.method).toBe('POST');
         expect((calls[0].options?.body as { keywords: { target_page: string }[] }).keywords[0].target_page).toBe('/pricing');
      } finally {
         await close();
      }
   });

   it('update_keyword forwards target_page in the PUT body with ids in the query', async () => {
      const { calls, client, close } = await setup();
      try {
         await client.callTool({ name: 'update_keyword', arguments: { ids: [42], target_page: '/new' } });
         expect(calls[0].path).toBe('/api/keywords');
         expect(calls[0].options?.method).toBe('PUT');
         expect(calls[0].options?.query).toEqual({ id: '42' });
         expect(calls[0].options?.body).toEqual({ target_page: '/new' });
      } finally {
         await close();
      }
   });

   it('get_insight sends the bounded default (no limit/detail) when the params are omitted', async () => {
      const { calls, client, close } = await setup();
      try {
         await client.callTool({ name: 'get_insight', arguments: { domain: 'example.com' } });
         expect(calls[0].path).toBe('/api/insight');
         expect(calls[0].options?.query).toEqual({ domain: 'example.com' });
      } finally {
         await close();
      }
   });

   it('get_insight forwards limit and detail as query params when provided', async () => {
      const { calls, client, close } = await setup();
      try {
         await client.callTool({ name: 'get_insight', arguments: { domain: 'example.com', limit: 50, detail: true } });
         expect(calls[0].options?.query).toEqual({ domain: 'example.com', limit: '50', detail: 'true' });
      } finally {
         await close();
      }
   });
});
