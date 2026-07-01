#!/usr/bin/env node
/**
 * s33k MCP server, stdio transport.
 *
 * Exposes s33k (an open, self-hosted SEO/AEO rank tracker forked from SerpBear) to an LLM over the
 * Model Context Protocol, speaking stdio. This entry point is intentionally thin: the 81 tools and
 * the knowledge resources live in ./tools.ts (registerS33kTools) so the SAME registrations are
 * shared with the hosted Streamable HTTP transport (pages/api/mcp). The only thing this file owns
 * is the stdio wiring and the fetchImpl bound to the LOCAL install's single Bearer key.
 *
 * Configuration comes from two environment variables:
 *   S33K_API_KEY   the value of APIKEY in the s33k .env file (required)
 *   S33K_BASE_URL  the base URL of the running s33k instance
 *                  (optional, defaults to http://localhost:3000)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerS33kTools, KNOWLEDGE_RESOURCES, FetchImpl } from './tools.js';

const API_KEY = process.env.S33K_API_KEY;
const BASE_URL = (process.env.S33K_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

if (!API_KEY) {
   // Write to stderr (stdout is reserved for the MCP protocol) and exit.
   process.stderr.write('s33k-mcp: S33K_API_KEY environment variable is required.\n');
   process.exit(1);
}

/**
 * Call the s33k REST API with the local install's Bearer API key. Returns the parsed JSON body.
 * Throws on non-2xx so each tool can surface the error. This is the stdio transport's fetchImpl:
 * it always carries S33K_API_KEY (the single key a local install owns). The hosted transport
 * supplies its OWN fetchImpl carrying the connecting client's key instead, never this one.
 */
const s33kFetch: FetchImpl = async (path, options = {}) => {
   const { method = 'GET', query, body } = options;
   const url = new URL(`${BASE_URL}${path}`);
   if (query) {
      for (const [key, value] of Object.entries(query)) {
         if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, value);
         }
      }
   }

   const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
   if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
   }

   const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
   });

   const text = await res.text();
   let parsed: any = null;
   try {
      parsed = text ? JSON.parse(text) : null;
   } catch {
      parsed = text;
   }

   if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : text;
      throw new Error(`s33k API ${method} ${path} failed (${res.status}): ${detail}`);
   }
   return parsed;
};

const server = new McpServer({
   name: 's33k-mcp',
   version: '0.1.0',
});

const { tools } = registerS33kTools(server, s33kFetch);

async function main() {
   const transport = new StdioServerTransport();
   await server.connect(transport);
   // Single-user: one flat tool surface, no admin gate.
   process.stderr.write(
      `s33k-mcp connected (base URL: ${BASE_URL}). ${tools} tools and ${KNOWLEDGE_RESOURCES.length} resources registered.\n`,
   );
}

main().catch((err) => {
   process.stderr.write(`s33k-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
   process.exit(1);
});
