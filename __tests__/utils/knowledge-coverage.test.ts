import fs from 'fs';
import path from 'path';

/**
 * THE DURABILITY GUARANTEE (build item 5).
 *
 * s33k is meant to be self-supporting: a user asks their own LLM ANY question about s33k and the
 * answer comes from the single product-knowledge layer (utils/knowledge.ts). That promise only
 * holds if EVERY registered MCP tool has a knowledge entry. This suite enforces exactly that, so
 * the answers can never silently rot.
 *
 * The coverage test enumerates every tool actually registered in the MCP server by parsing the
 * registerTool('<name>', ...) calls out of mcp/src/index.ts (the real, authoritative registry),
 * then asserts each one has a CapabilityEntry in knowledge.capabilities. If someone adds a tool
 * to the MCP server without adding a knowledge entry, this test fails and CI breaks. The
 * "proves it fails" test below demonstrates the guard is real by checking an undocumented tool
 * name against the same assertion.
 *
 * It also pins the other knowledge surfaces the self-support story depends on:
 *   - searchKnowledge returns topic-scoped content (the help tool / GET /api/help body);
 *   - crossCheckCapability (the "does s33k already do this?" safety net) pushes back on an
 *     existing capability and lets a genuinely-novel request through.
 *
 * Pure: it reads source text and calls pure functions. No MCP server boot, no network, no DB.
 */

// eslint-disable-next-line import/no-relative-packages
import knowledge, { searchKnowledge, crossCheckCapability, CapabilityEntry } from '../../utils/knowledge';

// The tool registrations were extracted from mcp/src/index.ts into the SHARED mcp/src/tools.ts
// (registerS33kTools), so the stdio entry and the hosted Streamable HTTP transport register the
// exact same set. The authoritative registry to parse is therefore tools.ts now, not index.ts
// (which is the thin stdio wiring and registers nothing itself).
const MCP_TOOLS_PATH = path.resolve(__dirname, '../../mcp/src/tools.ts');

/**
 * Parse the names of every tool registered in the MCP server straight from its source. The first
 * string argument to server.registerTool(...) is the tool name; this is the same list the live
 * server exposes over tools/list. Reading the source (rather than importing the module, which
 * connects a stdio transport at import time) makes this a static, side-effect-free enumeration.
 */
const readRegisteredToolNames = (): string[] => {
   const src = fs.readFileSync(MCP_TOOLS_PATH, 'utf8');
   const names: string[] = [];
   // Matches the single registration call site `server.registerTool('name', ...)`. Every registered
   // tool needs a knowledge entry and belongs in EXPECTED_TOOLS. (Single or double quotes, any whitespace.)
   const re = /server\.registerTool\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
   let m: RegExpExecArray | null = re.exec(src);
   while (m !== null) {
      names.push(m[1]);
      m = re.exec(src);
   }
   return names;
};

const SMOKE_TEST_PATH = path.resolve(__dirname, '../../mcp/smoke-test.mjs');

/**
 * Parse the EXPECTED_TOOLS array out of the MCP smoke test (mcp/smoke-test.mjs). The smoke test
 * asserts the live tools/list equals this list exactly, so if it drifts from the registered set the
 * documented `npm run smoke` verification hard-fails. Reading the source (not importing the ESM
 * harness, which boots a stdio child) keeps this a static, side-effect-free enumeration.
 */
const readSmokeExpectedTools = (): string[] => {
   const src = fs.readFileSync(SMOKE_TEST_PATH, 'utf8');
   const block = /const EXPECTED_TOOLS = \[([\s\S]*?)\];/.exec(src);
   if (!block) { return []; }
   const names: string[] = [];
   const re = /['"]([a-zA-Z0-9_]+)['"]/g;
   let m: RegExpExecArray | null = re.exec(block[1]);
   while (m !== null) {
      names.push(m[1]);
      m = re.exec(block[1]);
   }
   return names;
};

const knowledgeIds = new Set<string>(knowledge.capabilities.map((c: CapabilityEntry) => c.id));

/** The single assertion the durability guarantee rests on: this tool name has a knowledge entry. */
const assertDocumented = (toolName: string, documentedIds: Set<string>): void => {
   if (!documentedIds.has(toolName)) {
      throw new Error(
         `TOOL NOT DOCUMENTED: the MCP tool "${toolName}" has no entry in utils/knowledge.ts capabilities. `
         + 'Add a CapabilityEntry with id/toolName equal to the tool name so help, the resources, and the '
         + 'feature-request cross-check all know about it.',
      );
   }
};

describe('MCP knowledge coverage: every registered tool is documented', () => {
   const registeredTools = readRegisteredToolNames();

   it('actually found the registered tools in the MCP source (sanity guard)', () => {
      // If the parser ever silently matches nothing, the coverage test would pass vacuously. Guard
      // against that by asserting we found a realistic number of tools and some known names.
      expect(registeredTools.length).toBeGreaterThanOrEqual(30);
      expect(registeredTools).toEqual(expect.arrayContaining(['help', 'list_domains', 'add_keyword', 'ai_visibility', 'briefing']));
      // The tool names in the registry must be unique.
      expect(new Set(registeredTools).size).toBe(registeredTools.length);
   });

   it('FAILS THE BUILD if any registered MCP tool lacks a knowledge entry', () => {
      const undocumented = registeredTools.filter((name) => !knowledgeIds.has(name));
      // The assertion message names the offenders so a future contributor knows exactly what to add.
      expect(undocumented).toEqual([]);
   });

   it.each(readRegisteredToolNames())('tool "%s" has a knowledge entry whose id and toolName match', (toolName) => {
      const entry = knowledge.capabilities.find((c) => c.id === toolName);
      expect(entry).toBeDefined();
      // The toolName field must equal the id (the coverage contract the help/cross-check layers rely on).
      expect(entry!.toolName).toBe(toolName);
      // A real entry, not a stub: it must carry usable self-support content.
      expect(entry!.description.length).toBeGreaterThan(20);
      expect(entry!.whenToUse.length).toBeGreaterThan(10);
      expect(entry!.examplePrompt.length).toBeGreaterThan(5);
   });

   it('every knowledge capability maps back to a registered tool (no orphan docs)', () => {
      const registered = new Set(readRegisteredToolNames());
      const orphans = knowledge.capabilities.map((c) => c.id).filter((id) => !registered.has(id));
      expect(orphans).toEqual([]);
   });

   it('PROVES the guard is real: an undocumented tool name fails the same assertion', () => {
      // Inject a hypothetical newly-registered tool with no knowledge entry. The exact check the
      // coverage test runs must throw for it, demonstrating that adding a tool without documenting
      // it breaks CI. This is the durability guarantee, exercised directly.
      const phantomTool = 'export_to_csv_v2_undocumented';
      expect(knowledgeIds.has(phantomTool)).toBe(false);
      expect(() => assertDocumented(phantomTool, knowledgeIds)).toThrow(/TOOL NOT DOCUMENTED/);
      // And it does NOT throw for a tool that IS documented, confirming the guard is specific.
      expect(() => assertDocumented('briefing', knowledgeIds)).not.toThrow();
   });
});

describe('MCP smoke test EXPECTED_TOOLS stays in lockstep with the registered tools', () => {
   // The smoke test (mcp/smoke-test.mjs) is the documented verification artifact (`npm run smoke`) and
   // asserts the live tools/list equals EXPECTED_TOOLS exactly. That array is hand-maintained, so it
   // can silently fall behind the registered set (it once listed 42 while 76 were registered, which
   // would hard-fail the headline assertion). This guard fails the jest build the moment the two drift,
   // so the documented command can never be left broken.
   it('EXPECTED_TOOLS in the smoke test equals the registerTool names exactly', () => {
      const registered = [...new Set(readRegisteredToolNames())].sort();
      const smoke = [...new Set(readSmokeExpectedTools())].sort();
      // Sanity: the parser actually found a realistic list (never pass vacuously on a parse miss).
      expect(smoke.length).toBeGreaterThanOrEqual(30);
      const missingFromSmoke = registered.filter((t) => !smoke.includes(t));
      const extraInSmoke = smoke.filter((t) => !registered.includes(t));
      expect(missingFromSmoke).toEqual([]);
      expect(extraInSmoke).toEqual([]);
      expect(smoke).toEqual(registered);
   });
});

describe('help tool (searchKnowledge): returns topic-relevant content', () => {
   it('scopes capabilities to the SEO pillar when topic=seo and suppresses prose sections', () => {
      const result = searchKnowledge('', 'seo');
      expect(result.capabilities.length).toBeGreaterThan(0);
      expect(result.capabilities.every((c) => c.category === 'seo')).toBe(true);
      // A pure category topic returns the capability docs, not the reasoning/troubleshooting prose.
      expect(result.reasoning).toEqual([]);
      expect(result.troubleshooting).toEqual([]);
   });

   it('scopes capabilities to the AEO pillar when topic=aeo', () => {
      const result = searchKnowledge('', 'aeo');
      expect(result.capabilities.length).toBeGreaterThan(0);
      expect(result.capabilities.every((c) => c.category === 'aeo')).toBe(true);
      const names = result.capabilities.map((c) => c.toolName);
      expect(names).toEqual(expect.arrayContaining(['ai_referrals', 'ai_visibility']));
   });

   it('surfaces the trust/security facts for a security question', () => {
      const result = searchKnowledge('is s33k safe, do you train on my data?');
      expect(result.trust).not.toBeNull();
      // The trust slice references the single securityFacts source, not a duplicated copy.
      expect(result.trust!.facts).toBe(knowledge.trust.facts);
   });

   it('surfaces setup content for an install question', () => {
      const result = searchKnowledge('how do I add the tracking code and set up s33k?');
      expect(result.setup).not.toBeNull();
      expect(result.setup!.addTrackingCode.length).toBeGreaterThan(20);
   });

   it('returns matching capabilities ranked by a free-text query, not the whole catalog', () => {
      const result = searchKnowledge('how far do visitors scroll on my pages?');
      expect(result.capabilities.length).toBeGreaterThan(0);
      expect(result.capabilities.length).toBeLessThan(knowledge.capabilities.length);
      // The most relevant capability for that query is scroll_depth.
      expect(result.capabilities.map((c) => c.toolName)).toContain('scroll_depth');
   });

   it('never throws and always returns a usable slice, even for an empty query', () => {
      const result = searchKnowledge('');
      expect(result.capabilities.length).toBeGreaterThan(0);
      // With no query and no topic, the full self-support context is returned.
      expect(result.setup).not.toBeNull();
      expect(result.trust).not.toBeNull();
      expect(result.pricingAndLimits).not.toBeNull();
   });
});

describe('capability safety net (crossCheckCapability)', () => {
   it('matches a request that an EXISTING capability already satisfies', () => {
      const cases: { request: string, expected: string }[] = [
         { request: 'show me how far visitors scroll down each page', expected: 'scroll_depth' },
         { request: 'which AI engines like ChatGPT and Perplexity sent me referral traffic', expected: 'ai_referrals' },
      ];
      for (const { request, expected } of cases) {
         const match = crossCheckCapability(request);
         expect(match.matched).toBe(true);
         expect(match.capability).not.toBeNull();
         expect(match.capability!.toolName).toBe(expected);
      }
   });

   it('does NOT match a genuinely novel request (it should be stored, not pushed back)', () => {
      const novel = [
         'export my keyword rank history as a downloadable CSV file',
         // Was "monitor my Core Web Vitals LCP and CLS over time", but the web_vitals tool now
         // legitimately owns that ask, so it correctly matches and is no longer novel. Swapped for an
         // unambiguously novel request (a UI theme toggle, which no tool provides; "digest" would
         // match weekly_digest) so the test still proves a genuinely new feature ask stays stored.
         'add dark mode and light mode theme switching to the UI',
         // Was "post my analytics summary into a Slack channel automatically", but segment_analytics
         // and campaign_report now legitimately own "analytics summary" vocabulary, so the only novel
         // part of that phrase was the Slack/automation integration. Swapped for an unambiguously
         // novel request (CRM integration, which no tool provides) so the test still proves a genuinely
         // new feature ask stays stored rather than pushed back.
         'integrate s33k with my CRM like Salesforce or HubSpot to sync conversions',
      ];
      for (const request of novel) {
         const match = crossCheckCapability(request);
         expect(match.matched).toBe(false);
         expect(match.capability).toBeNull();
      }
   });

   it('never maps a request onto the meta/self-support tool', () => {
      // A request that mentions "help" must not resolve to the help tool itself.
      const match = crossCheckCapability('I want a feature to request features more easily');
      if (match.matched) {
         expect(['help']).not.toContain(match.capability!.toolName);
      }
   });

   it('returns no match for empty or whitespace request text', () => {
      expect(crossCheckCapability('').matched).toBe(false);
      expect(crossCheckCapability('   ').matched).toBe(false);
   });
});

