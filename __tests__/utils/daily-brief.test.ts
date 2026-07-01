/**
 * Tests for the pure daily-brief composer (utils/daily-brief.ts) and its two
 * renderers (utils/daily-brief-render.ts).
 *
 * The composer is a pure join over three already-shaped signals: the analyst's
 * period-over-period change detection, the AEO ROI top opportunity, and the
 * dashboard headline opportunity page. Its contracts:
 *
 *   1. RICH DATA: with real changes it leads the headline with the top change,
 *      surfaces the top few changes as bullets, and the top action carries the
 *      analyst priority enriched with the AEO opportunity.
 *   2. HONEST QUIET: with no changes and no opportunity it sets quiet=true, an
 *      empty whatChanged, an honest "nothing material changed" headline, and a
 *      calm fallback action. It NEVER fabricates a change.
 *   3. RENDER: both renderers return a non-empty string and escape interpolated
 *      brief text so content can never break the email or inject markup.
 *
 * Pure: no DB, no network, no LLM.
 */

import { composeDailyBrief, DailyBriefInput } from '../../utils/daily-brief';
import { renderDailyBriefText, renderDailyBriefHtml } from '../../utils/daily-brief-render';
import type { AnalystOutput, Alert } from '../../utils/analyst';
import type { AeoRoi } from '../../utils/aeo-roi';

/** A minimal high-severity rank alert for the headline-leads test. */
const rankAlert = (): Alert => ({
   severity: 'high',
   pillar: 'rank',
   headline: '"masset" climbed from #12 to #4 and reached page one.',
   detail: 'Crossing into the top 10 is where clicks accelerate.',
   recommendation: 'Capitalize now: make sure the ranking page converts.',
});

/** A medium AI alert, lower in priority than the rank one. */
const aiAlert = (): Alert => ({
   severity: 'medium',
   pillar: 'ai',
   headline: 'ChatGPT referrals grew 200% (10 to 30 visitors).',
   detail: 'AI-referred visitors from ChatGPT changed 200% versus the prior period.',
   recommendation: 'Keep the pages ChatGPT cites fresh and answer-ready.',
});

/** An analyst output with two prioritized alerts and a derived topPriority. */
const analystWithChanges = (): AnalystOutput => {
   const alerts = [rankAlert(), aiAlert()];
   return { alerts, topPriority: `${alerts[0].headline} ${alerts[0].recommendation}` };
};

/** A quiet analyst output: nothing changed. */
const analystQuiet = (): AnalystOutput => ({ alerts: [], topPriority: null });

/** An AEO ROI carrying a single "cited-not-converting" opportunity. */
const aeoWithOpportunity = (): AeoRoi => ({
   totalAiSessions: 5,
   aiConversions: 0,
   totalAiRevenue: null,
   byPage: [],
   opportunities: [{
      type: 'cited-not-converting',
      page: '/software/mcp',
      detail: '/software/mcp gets 5 AI-referred visitor(s) but none converted. Fix the page (clearer offer, stronger CTA).',
   }],
   note: 'AI engines referred 5 session(s).',
});

const baseInput = (overrides: Partial<DailyBriefInput> = {}): DailyBriefInput => ({
   domain: 'getmasset.com',
   period: '7d',
   analyst: analystQuiet(),
   aeoRoi: null,
   dashboardHeadline: null,
   ...overrides,
});

describe('composeDailyBrief: rich data', () => {
   it('leads the headline with the top change and lists the top changes', () => {
      const brief = composeDailyBrief(baseInput({ analyst: analystWithChanges() }));
      expect(brief.quiet).toBe(false);
      expect(brief.headline).toMatch(/"masset" climbed/);
      expect(brief.whatChanged.length).toBe(2);
      expect(brief.whatChanged[0].pillar).toBe('rank');
      expect(brief.whatChanged[0].severity).toBe('high');
   });

   it('builds the top action from the analyst priority enriched with the AEO opportunity', () => {
      const brief = composeDailyBrief(baseInput({
         analyst: analystWithChanges(),
         aeoRoi: aeoWithOpportunity(),
      }));
      // Analyst priority leads the action.
      expect(brief.topAction).toMatch(/Capitalize now/);
      // The AEO opportunity is folded in as the AI angle.
      expect(brief.topAction).toMatch(/AI visibility:/);
      expect(brief.topAction).toMatch(/\/software\/mcp/);
   });

   it('caps whatChanged at 4 bullets even when more changes exist', () => {
      const manyAlerts: Alert[] = Array.from({ length: 7 }, (_v, i) => ({
         severity: 'medium' as const,
         pillar: 'traffic' as const,
         headline: `change ${i}`,
         detail: 'd',
         recommendation: 'r',
      }));
      const brief = composeDailyBrief(baseInput({ analyst: { alerts: manyAlerts, topPriority: 'change 0 r' } }));
      expect(brief.whatChanged.length).toBe(4);
   });

   it('uses the dashboard opportunity page as the headline when nothing changed but an opportunity exists', () => {
      const brief = composeDailyBrief(baseInput({
         analyst: analystQuiet(),
         dashboardHeadline: { topOpportunity: '/pricing earns 200 pageviews but has no tracked keyword. Add one.', topAction: 'Add a keyword.' },
      }));
      expect(brief.quiet).toBe(false);
      expect(brief.headline).toMatch(/\/pricing earns 200 pageviews/);
   });
});

describe('composeDailyBrief: honest quiet period', () => {
   it('sets quiet=true, empty changes, an honest headline, and a calm fallback action', () => {
      const brief = composeDailyBrief(baseInput());
      expect(brief.quiet).toBe(true);
      expect(brief.whatChanged).toEqual([]);
      expect(brief.headline).toMatch(/Quiet period for getmasset.com/);
      // No fabricated action: it falls back to a calm keep-fresh line.
      expect(brief.topAction).toMatch(/No urgent action this period/);
   });

   it('does not treat the dashboard generic fallback action as a real signal (stays quiet)', () => {
      // A dashboard with a fallback topAction but NO topOpportunity is an empty domain; the brief
      // must still report quiet and must not invent a change, but may use the dashAction as a step.
      const brief = composeDailyBrief(baseInput({
         dashboardHeadline: { topOpportunity: null, topAction: 'Install the s33k.js tracking script so traffic starts flowing in.' },
      }));
      expect(brief.quiet).toBe(true);
      expect(brief.whatChanged).toEqual([]);
      expect(brief.topAction).toMatch(/Install the s33k.js tracking script/);
   });

   it('never throws on fully empty input and always returns a non-empty headline and action', () => {
      const brief = composeDailyBrief(baseInput());
      expect(typeof brief.headline).toBe('string');
      expect(brief.headline.length).toBeGreaterThan(0);
      expect(brief.topAction.length).toBeGreaterThan(0);
   });
});

describe('composeDailyBrief: gathering (first-data) state', () => {
   it('leads with an encouraging "first check is running" headline and never a flat quiet/zero', () => {
      const brief = composeDailyBrief(baseInput({
         setup: { noKeywords: false, noTraffic: true, rankPending: true },
      }));
      // A gathering domain is NOT a quiet one.
      expect(brief.quiet).toBe(false);
      expect(brief.dataState).toBe('gathering');
      expect(brief.headline).toMatch(/First check is running for getmasset.com/);
      expect(brief.headline).toMatch(/first real brief lands within a day/i);
      // It must not present a flat quiet/zero line.
      expect(brief.headline).not.toMatch(/Quiet period/);
      expect(brief.whatChanged).toEqual([]);
   });

   it('writes a setup-aware top action (add keywords / install script), not the calm keep-fresh line', () => {
      const brief = composeDailyBrief(baseInput({
         setup: { noKeywords: true, noTraffic: true, rankPending: false },
      }));
      expect(brief.dataState).toBe('gathering');
      expect(brief.topAction).toMatch(/Add the keywords/i);
      expect(brief.topAction).toMatch(/tracking script/i);
      // NOT the normal-quiet fallback action.
      expect(brief.topAction).not.toMatch(/No urgent action this period/);
   });

   it('points a rank-pending domain at waiting for the first check, no fake "not in top 100"', () => {
      const brief = composeDailyBrief(baseInput({
         setup: { noKeywords: false, noTraffic: false, rankPending: true },
      }));
      expect(brief.dataState).toBe('gathering');
      expect(brief.topAction).toMatch(/first rank check is running/i);
      expect(brief.topAction).not.toMatch(/not in top 100/i);
      expect(brief.topAction).not.toMatch(/not on page one/i);
   });

   it('ignores the setup signal once real data has landed (normal change path)', () => {
      const brief = composeDailyBrief(baseInput({ analyst: analystWithChanges() }));
      expect(brief.dataState).toBeUndefined();
      expect(brief.headline).toMatch(/"masset" climbed/);
   });
});

describe('daily-brief renderers', () => {
   it('renderDailyBriefText returns a non-empty monospace block with the headline and top action', () => {
      const brief = composeDailyBrief(baseInput({ analyst: analystWithChanges() }));
      const text = renderDailyBriefText(brief);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/s33k DAILY BRIEF/);
      expect(text).toMatch(/TOP ACTION/);
      // No em dash ever.
      expect(text.includes('\u2014')).toBe(false);
   });

   it('renderDailyBriefText shows an honest quiet line when nothing changed', () => {
      const text = renderDailyBriefText(composeDailyBrief(baseInput()));
      expect(text).toMatch(/Quiet period/);
   });

   it('renderDailyBriefHtml returns a non-empty HTML block and escapes interpolated content', () => {
      // A headline containing HTML must be escaped, never rendered as markup.
      const dangerous: AnalystOutput = {
         alerts: [{
            severity: 'high', pillar: 'rank', headline: '<script>alert(1)</script> "x<y" rose', detail: 'd', recommendation: 'r',
         }],
         topPriority: '<b>do this</b>',
      };
      const html = renderDailyBriefHtml(composeDailyBrief(baseInput({ analyst: dangerous })));
      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(0);
      // The raw script tag must be escaped, not present as live markup.
      expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
      expect(html).toMatch(/&lt;script&gt;/);
      expect(html.includes('\u2014')).toBe(false);
   });
});
