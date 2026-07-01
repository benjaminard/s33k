/**
 * Tests for the proactive-analyst change-detection engine (utils/analyst.ts).
 *
 * detectChanges is a PURE function: given a current period and a prior period
 * across all four pillars (rank, traffic, AI visibility, conversions), it returns
 * a prioritized list of plain-English alerts plus the single most important thing
 * to do. No DB, no network, no LLM, no clock, no randomness, so it is exhaustively
 * testable from its inputs alone.
 *
 * Contract under test:
 *   1. RANK: page-one crossings (high), >= 5-position moves (medium), newly-ranked
 *      and newly-dropped keywords, and SILENCE when there is no prior reading.
 *   2. TRAFFIC: a >= 25% swing (medium) / >= 50% swing (high) off a NON-ZERO prior
 *      baseline; silence when the prior baseline is zero.
 *   3. AI: a brand-new referring engine fires HIGH off a zero prior (the one rule
 *      that fires "from nothing"); existing-engine >= 30% moves.
 *   4. CONVERSIONS: a >= 30% form-submission change (drop = high, rise = medium),
 *      silent off a zero prior baseline.
 *   5. NO-CHANGE: a quiet period yields zero alerts and a null topPriority (honest).
 *   6. MISSING-DATA: empty/zero pillars never fabricate an alert.
 *   7. PRIORITIZATION: alerts sort highest-signal first (severity, then the stable
 *      rank/traffic/ai/conversions pillar tiebreak), and topPriority is the top
 *      alert's headline + recommendation.
 */

import {
   detectChanges,
   PeriodData,
   KeywordRank,
   AiEngineCount,
} from '../../utils/analyst';

/** A fully-quiet period: every pillar present but identical to its pair, so nothing fires. */
const quietPeriod = (overrides: Partial<PeriodData> = {}): PeriodData => ({
   keywords: [],
   traffic: { pageviews: 100, visitors: 80 },
   aiEngines: [],
   formSubmissions: 10,
   ...overrides,
});

/** Build a current/prior pair from two partials over the same quiet baseline. */
const pair = (cur: Partial<PeriodData>, prior: Partial<PeriodData>) => ({
   current: quietPeriod(cur),
   prior: quietPeriod(prior),
});

const kw = (keyword: string, position: number | null, targetPage?: string): KeywordRank => ({
   keyword, position, targetPage,
});

const ai = (engine: string, visitors: number): AiEngineCount => ({ engine, visitors });

describe('detectChanges: RANK pillar', () => {
   it('flags a high-severity alert when a keyword falls OFF page one', () => {
      const { current, prior } = pair(
         { keywords: [kw('DAM MCP server', 11, '/software/mcp')] },
         { keywords: [kw('DAM MCP server', 4, '/software/mcp')] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/#4 to #11/);
      expect(rank[0].headline).toMatch(/page one/i);
      // The target page is named so the LLM can point at it.
      expect(rank[0].headline).toMatch(/\/software\/mcp/);
   });

   it('flags a high-severity alert when a keyword climbs ONTO page one', () => {
      const { current, prior } = pair(
         { keywords: [kw('AI-ready DAM', 6)] },
         { keywords: [kw('AI-ready DAM', 18)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/#18 to #6/);
      expect(rank[0].headline).toMatch(/page one/i);
   });

   it('flags a medium-severity alert for a >= 5-position move that stays on the same side', () => {
      const { current, prior } = pair(
         { keywords: [kw('Highspot alternative', 30)] },
         { keywords: [kw('Highspot alternative', 22)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('medium');
      expect(rank[0].headline).toMatch(/fell 8 spots/);
      expect(rank[0].headline).toMatch(/#22 to #30/);
   });

   it('does NOT flag a sub-threshold move (4 positions, same side, no crossing)', () => {
      const { current, prior } = pair(
         { keywords: [kw('Seismic alternative', 38)] },
         { keywords: [kw('Seismic alternative', 34)] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'rank')).toHaveLength(0);
   });

   it('flags newly-ranked (was unranked, now ranks) as a win, high when on page one', () => {
      const { current, prior } = pair(
         { keywords: [kw('how to make website AI readable', 7)] },
         { keywords: [kw('how to make website AI readable', null)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/started ranking at #7/);
   });

   it('flags newly-dropped-off (had a rank, now unranked) as a loss', () => {
      const { current, prior } = pair(
         { keywords: [kw('masset', null)] },
         { keywords: [kw('masset', 3)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/dropped off/i);
      expect(rank[0].headline).toMatch(/#3/);
   });

   it('treats a position <= 0 as unranked (distinct from a real rank)', () => {
      // current 0 (unranked) vs prior 5 (ranked) is a drop-off, not a "rose 5 spots".
      const { current, prior } = pair(
         { keywords: [kw('DAM MCP server', 0)] },
         { keywords: [kw('DAM MCP server', 5)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].headline).toMatch(/dropped off/i);
   });

   it('stays SILENT for a keyword with no prior reading (a first sighting is not a change)', () => {
      const { current, prior } = pair(
         { keywords: [kw('brand new term', 8)] },
         { keywords: [] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'rank')).toHaveLength(0);
   });

   it('stays SILENT when a keyword is unranked in BOTH periods', () => {
      const { current, prior } = pair(
         { keywords: [kw('never ranks', null)] },
         { keywords: [kw('never ranks', null)] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'rank')).toHaveLength(0);
   });
});

describe('detectChanges: TRAFFIC pillar', () => {
   it('flags medium for a >= 25% but < 50% swing off a non-zero baseline', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 130, visitors: 80 } }, // +30% pageviews, visitors unchanged
         { traffic: { pageviews: 100, visitors: 80 } },
      );
      const out = detectChanges(current, prior);
      const traffic = out.alerts.filter((a) => a.pillar === 'traffic');
      expect(traffic).toHaveLength(1);
      expect(traffic[0].severity).toBe('medium');
      expect(traffic[0].headline).toMatch(/Pageviews rose 30%/);
   });

   it('flags high for a >= 50% swing, and reports pageviews and visitors separately', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 50, visitors: 40 } }, // -50% both
         { traffic: { pageviews: 100, visitors: 80 } },
      );
      const out = detectChanges(current, prior);
      const traffic = out.alerts.filter((a) => a.pillar === 'traffic');
      expect(traffic).toHaveLength(2);
      expect(traffic.every((a) => a.severity === 'high')).toBe(true);
      expect(traffic.map((a) => a.headline).join(' ')).toMatch(/Pageviews fell 50%/);
      expect(traffic.map((a) => a.headline).join(' ')).toMatch(/Visitors fell 50%/);
   });

   it('does NOT flag a sub-threshold (< 25%) swing', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 110, visitors: 88 } }, // +10%
         { traffic: { pageviews: 100, visitors: 80 } },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'traffic')).toHaveLength(0);
   });

   it('stays SILENT when the prior baseline is ZERO (no fabricated swing from nothing)', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 500, visitors: 400 } },
         { traffic: { pageviews: 0, visitors: 0 } },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'traffic')).toHaveLength(0);
   });
});

describe('detectChanges: AI pillar', () => {
   it('flags HIGH when a brand-new AI engine starts referring (fires from a zero prior)', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('ChatGPT', 12)] },
         { aiEngines: [] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('high');
      expect(aiAlerts[0].headline).toMatch(/ChatGPT started referring/);
   });

   it('flags medium for an existing engine whose referrals move >= 30%', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('Perplexity', 20)] }, // +100%
         { aiEngines: [ai('Perplexity', 10)] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('medium');
      expect(aiAlerts[0].headline).toMatch(/Perplexity referrals grew/);
   });

   it('does NOT flag an existing engine whose referrals move < 30%', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('ChatGPT', 11)] }, // +10%
         { aiEngines: [ai('ChatGPT', 10)] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'ai')).toHaveLength(0);
   });

   it('flags HIGH when an engine COLLAPSES from a real baseline to near zero (lost citation)', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('Perplexity', 0)] }, // fell to 0 from a meaningful baseline
         { aiEngines: [ai('Perplexity', 14)] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('high');
      expect(aiAlerts[0].headline).toMatch(/Perplexity referrals collapsed/);
      expect(aiAlerts[0].headline).toMatch(/14 visitors last period, 0 now/);
   });

   it('treats a collapse to 1 visitor from a real baseline as a HIGH collapse', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('ChatGPT', 1)] }, // 20 -> 1 is a collapse, not just a >= 30% shrink
         { aiEngines: [ai('ChatGPT', 20)] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('high');
      expect(aiAlerts[0].headline).toMatch(/collapsed/);
   });

   it('does NOT call a fall from a TINY baseline a collapse (it is the ordinary medium shrink)', () => {
      // Prior 4 (< the collapse baseline of 5) falling to 0 is a normal >= 30% drop, MEDIUM, not a collapse.
      const { current, prior } = pair(
         { aiEngines: [ai('Gemini', 0)] },
         { aiEngines: [ai('Gemini', 4)] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('medium');
      expect(aiAlerts[0].headline).toMatch(/Gemini referrals fell/);
      expect(aiAlerts[0].headline).not.toMatch(/collapsed/);
   });

   it('a >= 30% shrink that stays well above zero is a MEDIUM fall, not a collapse', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('ChatGPT', 12)] }, // 20 -> 12 is -40% but 12 is not near zero
         { aiEngines: [ai('ChatGPT', 20)] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('medium');
      expect(aiAlerts[0].headline).not.toMatch(/collapsed/);
   });
});

describe('detectChanges: CONVERSIONS pillar', () => {
   it('flags HIGH for a >= 30% DROP in form submissions (a drop is urgent)', () => {
      const { current, prior } = pair(
         { formSubmissions: 6 }, // -40% volume; rate also falls (6/80 < 10/80 * 0.8), so a rate alert co-fires
         { formSubmissions: 10 },
      );
      const out = detectChanges(current, prior);
      const conv = out.alerts.filter((a) => a.pillar === 'conversions');
      // Both the VOLUME drop and the RATE drop fire here (steady 80 visitors, fewer submissions).
      const volume = conv.find((a) => /Form submissions fell 40%/.test(a.headline));
      expect(volume).toBeDefined();
      expect(volume!.severity).toBe('high');
   });

   it('flags MEDIUM for a >= 30% RISE in form submissions', () => {
      const { current, prior } = pair(
         { formSubmissions: 15 }, // +50%
         { formSubmissions: 10 },
      );
      const out = detectChanges(current, prior);
      const conv = out.alerts.filter((a) => a.pillar === 'conversions');
      expect(conv).toHaveLength(1);
      expect(conv[0].severity).toBe('medium');
      expect(conv[0].headline).toMatch(/Form submissions rose 50%/);
   });

   it('does NOT flag a sub-threshold (< 30%) conversion change', () => {
      const { current, prior } = pair(
         { formSubmissions: 12 }, // +20%
         { formSubmissions: 10 },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'conversions')).toHaveLength(0);
   });

   it('stays SILENT when the prior submission baseline is ZERO', () => {
      const { current, prior } = pair(
         { formSubmissions: 25 },
         { formSubmissions: 0 },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'conversions')).toHaveLength(0);
   });
});

describe('detectChanges: CONVERSION-RATE pillar', () => {
   it('flags a RATE drop even when raw volume barely moved (rate per visitor fell on rising traffic)', () => {
      // Volume 10 -> 9 is only -10% (no volume alert), but visitors doubled, so the RATE halved.
      const { current, prior } = pair(
         { formSubmissions: 9, traffic: { pageviews: 400, visitors: 200 } }, // 9/200 = 4.5%
         { formSubmissions: 10, traffic: { pageviews: 200, visitors: 100 } }, // 10/100 = 10%
      );
      const out = detectChanges(current, prior);
      const conv = out.alerts.filter((a) => a.pillar === 'conversions');
      const rate = conv.find((a) => /conversion rate fell/i.test(a.headline));
      expect(rate).toBeDefined();
      // 4.5% is <= 50% of 10%, so the rate roughly halved -> HIGH.
      expect(rate!.severity).toBe('high');
      expect(rate!.headline).toMatch(/10% to 4\.5% of visitors/);
   });

   it('flags MEDIUM for a >= 20% but < 50% relative rate drop', () => {
      // 10/100 = 10% prior; 14/200 = 7% current. 7% is 70% of 10%: a 30% relative drop, below the halved threshold.
      const { current, prior } = pair(
         { formSubmissions: 14, traffic: { pageviews: 600, visitors: 200 } },
         { formSubmissions: 10, traffic: { pageviews: 300, visitors: 100 } },
      );
      const out = detectChanges(current, prior);
      const rate = out.alerts.filter((a) => a.pillar === 'conversions').find((a) => /conversion rate fell/i.test(a.headline));
      expect(rate).toBeDefined();
      expect(rate!.severity).toBe('medium');
   });

   it('does NOT flag a rate alert when the prior visitor denominator is too small to trust', () => {
      // Prior visitors 10 (< the 20-visitor floor): a 1/10 -> 0/40 swing is not a trustworthy rate collapse.
      const { current, prior } = pair(
         { formSubmissions: 1, traffic: { pageviews: 80, visitors: 40 } },
         { formSubmissions: 5, traffic: { pageviews: 20, visitors: 10 } },
      );
      const out = detectChanges(current, prior);
      const rate = out.alerts.filter((a) => a.pillar === 'conversions').find((a) => /conversion rate fell/i.test(a.headline));
      expect(rate).toBeUndefined();
   });

   it('does NOT flag a rate alert when the conversion rate held steady or rose', () => {
      // Volume up, visitors up proportionally: rate steady. No rate drop.
      const { current, prior } = pair(
         { formSubmissions: 20, traffic: { pageviews: 400, visitors: 200 } }, // 10%
         { formSubmissions: 10, traffic: { pageviews: 200, visitors: 100 } }, // 10%
      );
      const out = detectChanges(current, prior);
      const rate = out.alerts.filter((a) => a.pillar === 'conversions').find((a) => /conversion rate fell/i.test(a.headline));
      expect(rate).toBeUndefined();
   });
});

describe('detectChanges: no-change and missing-data honesty', () => {
   it('returns zero alerts and a null topPriority for a genuinely quiet period', () => {
      const out = detectChanges(quietPeriod(), quietPeriod());
      expect(out.alerts).toEqual([]);
      expect(out.topPriority).toBeNull();
   });

   it('never fabricates an alert when every pillar is empty/zero in both periods', () => {
      const empty: PeriodData = {
         keywords: [], traffic: { pageviews: 0, visitors: 0 }, aiEngines: [], formSubmissions: 0,
      };
      const out = detectChanges(empty, empty);
      expect(out.alerts).toEqual([]);
      expect(out.topPriority).toBeNull();
   });

   it('fires only the pillars that have real deltas, ignoring the quiet ones', () => {
      // Only AI has a change; rank/traffic/conversions are identical baselines.
      const { current, prior } = pair(
         { aiEngines: [ai('Gemini', 9)] },
         { aiEngines: [] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts).toHaveLength(1);
      expect(out.alerts[0].pillar).toBe('ai');
   });
});

describe('detectChanges: prioritization order', () => {
   it('sorts high-severity alerts before medium ones regardless of pillar', () => {
      // A medium traffic alert AND a high AI alert; the high one must come first.
      const current = quietPeriod({
         traffic: { pageviews: 130, visitors: 80 }, // +30% -> medium traffic
         aiEngines: [ai('ChatGPT', 5)], // new engine -> high ai
      });
      const prior = quietPeriod({
         traffic: { pageviews: 100, visitors: 80 },
         aiEngines: [],
      });
      const out = detectChanges(current, prior);
      expect(out.alerts.length).toBeGreaterThanOrEqual(2);
      expect(out.alerts[0].severity).toBe('high');
      expect(out.alerts[0].pillar).toBe('ai');
      // The medium traffic alert is ordered after the high one.
      const severities = out.alerts.map((a) => a.severity);
      expect(severities.indexOf('high')).toBeLessThan(severities.indexOf('medium'));
   });

   it('breaks severity ties by the stable pillar order rank < traffic < ai < conversions', () => {
      // Two HIGH alerts: a rank page-one drop and a conversions drop. Rank must sort first.
      const current = quietPeriod({
         keywords: [kw('masset', 12)], // was 4 -> off page one -> high rank
         formSubmissions: 5, // -50% -> high conversions
      });
      const prior = quietPeriod({
         keywords: [kw('masset', 4)],
         formSubmissions: 10,
      });
      const out = detectChanges(current, prior);
      const highs = out.alerts.filter((a) => a.severity === 'high');
      expect(highs.length).toBeGreaterThanOrEqual(2);
      expect(highs[0].pillar).toBe('rank');
      const pillarsInOrder = out.alerts.filter((a) => a.severity === 'high').map((a) => a.pillar);
      expect(pillarsInOrder.indexOf('rank')).toBeLessThan(pillarsInOrder.indexOf('conversions'));
   });

   it('derives topPriority from the top alert (its headline + recommendation)', () => {
      const { current, prior } = pair(
         { keywords: [kw('DAM MCP server', 11, '/software/mcp')] }, // high rank drop
         { keywords: [kw('DAM MCP server', 4, '/software/mcp')] },
      );
      const out = detectChanges(current, prior);
      expect(out.topPriority).not.toBeNull();
      const top = out.alerts[0];
      expect(out.topPriority).toBe(`${top.headline} ${top.recommendation}`);
   });
});
