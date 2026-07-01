/**
 * Provider-name leak guard.
 *
 * mcp/src/tools.ts (MCP tool descriptions) and utils/knowledge.ts (the user-facing knowledge
 * base) are surfaces a customer's own LLM reads. Internal provider/vendor names (umami, lodd,
 * serpbear) and the raw *.up.railway.app collector host must never appear there: they leak
 * implementation detail, confuse the user, and a stale brand name erodes trust in every number.
 * This test reads the raw source text of both files and asserts ZERO occurrences, mirroring the
 * repo's zero-count em-dash discipline so the scrub cannot silently regress.
 */
import fs from 'fs';
import path from 'path';

const TOOLS_SRC = fs.readFileSync(path.join(__dirname, '../../mcp/src/tools.ts'), 'utf8');
const KNOWLEDGE_SRC = fs.readFileSync(path.join(__dirname, '../../utils/knowledge.ts'), 'utf8');

const countMatches = (text: string, re: RegExp): number => (text.match(re) || []).length;

describe('no provider-name leak in user-facing MCP surfaces', () => {
   it('mcp/src/tools.ts names no internal provider/vendor and no raw railway host', () => {
      expect(countMatches(TOOLS_SRC, /\b(umami|lodd|serpbear)\b/gi)).toBe(0);
      expect(countMatches(TOOLS_SRC, /up\.railway\.app/gi)).toBe(0);
   });

   it('utils/knowledge.ts names no internal provider/vendor and no raw railway host', () => {
      expect(countMatches(KNOWLEDGE_SRC, /\b(umami|lodd|serpbear)\b/gi)).toBe(0);
      expect(countMatches(KNOWLEDGE_SRC, /up\.railway\.app/gi)).toBe(0);
   });
});
