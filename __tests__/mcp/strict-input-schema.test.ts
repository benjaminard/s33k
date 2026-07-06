/**
 * MCP-layer contract test for issue #22: a caller who misnames an argument (real case: targetPage
 * instead of target_page) used to get NO error, since schema validation silently stripped the
 * unknown key and the call "succeeded" without doing what the caller intended. Driven over a REAL
 * SDK client/server pair (InMemoryTransport), the same pattern as keyword-insight-tool-contract.test.ts,
 * so the full tools/call path (schema validation included) is exercised, not just the handler function.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerS33kTools, FetchImpl } from '../../mcp/src/tools';

const setup = async () => {
   const fetchImpl: FetchImpl = async () => ({ keywords: [{ ID: 1 }], data: {} });
   const server = new McpServer({ name: 'strict-schema-test', version: '0.0.0' });
   registerS33kTools(server, fetchImpl);
   const client = new Client({ name: 'strict-schema-test-client', version: '0.0.0' });
   const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
   await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
   return { client, close: async () => { await client.close(); await server.close(); } };
};

describe('MCP tool input schemas are strict (issue #22)', () => {
   it('advertises additionalProperties: false in tools/list, so a well-behaved client never sends an unknown key', async () => {
      const { client, close } = await setup();
      try {
         const { tools } = await client.listTools();
         const addKeyword = tools.find((t) => t.name === 'add_keyword')!;
         expect(addKeyword.inputSchema.additionalProperties).toBe(false);
         expect(Object.keys(addKeyword.inputSchema.properties ?? {})).toEqual(
            expect.arrayContaining(['keyword', 'domain', 'country', 'device', 'target_page']),
         );
      } finally {
         await close();
      }
   });

   it('rejects a misnamed argument and names it, with a "did you mean" hint for a close typo', async () => {
      const { client, close } = await setup();
      try {
         const result = await client.callTool({
            name: 'add_keyword',
            arguments: { keyword: 'seo tools', domain: 'example.com', targetPage: '/software/mcp' },
         }) as { isError?: boolean, content: { type: string, text: string }[] };
         expect(result.isError).toBe(true);
         const message = result.content[0].text;
         expect(message).toContain('targetPage');
         expect(message).toContain('target_page');
      } finally {
         await close();
      }
   });

   it('rejects an unknown key on a zero-argument tool instead of silently ignoring it', async () => {
      const { client, close } = await setup();
      try {
         const result = await client.callTool({
            name: 'list_domains',
            arguments: { verbose: true },
         }) as { isError?: boolean, content: { type: string, text: string }[] };
         expect(result.isError).toBe(true);
         expect(result.content[0].text).toContain('verbose');
      } finally {
         await close();
      }
   });

   it('still accepts a correctly-named call (no regression on the legitimate path)', async () => {
      const { client, close } = await setup();
      try {
         const result = await client.callTool({
            name: 'add_keyword',
            arguments: { keyword: 'seo tools', domain: 'example.com', target_page: '/software/mcp' },
         }) as { isError?: boolean };
         expect(result.isError).toBeFalsy();
      } finally {
         await close();
      }
   });
});
