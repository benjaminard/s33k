/*
 * ============================================================================
 * s33k DASHBOARD RENDERER: the default visual (monospace, box-drawn, ~78 cols).
 * ============================================================================
 * "Even an ugly MS-DOS-looking thing is fine." renderDashboard turns a composed
 * Dashboard plus its suggested questions into ONE self-contained monospace text
 * block that renders cleanly in any terminal, chat, or plain-text tool with zero
 * further formatting. It is the default view the connected LLM can show verbatim,
 * alongside the structured data for a richer render.
 *
 * Pure, no color codes, no em dashes, ASCII box-drawing characters only. Width is
 * fixed at 78 content columns inside a 78-wide frame so it fits an 80-col terminal
 * and most chat code blocks. Every line is padded/truncated to fit, so nothing
 * ever breaks the box.
 * ============================================================================
 */

import type { Dashboard, DashboardWebVitals } from './dashboard';
import type { SuggestedQuestion } from './suggested-questions';

// Inner content width (between the two vertical bars). Frame is W + 2.
const W = 78;

/** Truncate to n chars with a trailing ".." when cut, so a long path never overflows the box. */
const clip = (s: string, n: number): string => {
   const str = String(s ?? '');
   if (str.length <= n) { return str; }
   if (n <= 2) { return str.slice(0, n); }
   return `${str.slice(0, n - 2)}..`;
};

/** Pad a string to width n on the right (left-aligned). Truncates if too long. */
const padR = (s: string, n: number): string => clip(s, n).padEnd(n, ' ');

/** Pad a string to width n on the left (right-aligned). Truncates if too long. */
const padL = (s: string, n: number): string => clip(s, n).padStart(n, ' ');

/** A full horizontal rule: left-corner, fill, right-corner. */
const rule = (left: string, fill: string, right: string): string => `${left}${fill.repeat(W)}${right}`;

/** A content line: vertical bar, padded text to W, vertical bar. */
const line = (text: string): string => `|${padR(` ${text}`, W)}|`;

/** A blank content line. */
const blank = (): string => `|${' '.repeat(W)}|`;

/** A section header bar: a label inside a light rule, e.g. "+-- SEO RANK ----+". */
const section = (label: string): string => {
   const tag = ` ${label} `;
   const remaining = Math.max(0, W - tag.length - 2);
   return `+${'-'.padStart(2, '-')}${tag}${'-'.repeat(remaining)}+`;
};

/** Wrap a long string into lines of at most W-1 content chars (accounting for the leading space). */
const wrap = (text: string, width: number): string[] => {
   const words = String(text ?? '').split(/\s+/).filter(Boolean);
   const lines: string[] = [];
   let cur = '';
   for (const w of words) {
      if (!cur) {
         cur = w;
      } else if (`${cur} ${w}`.length <= width) {
         cur = `${cur} ${w}`;
      } else {
         lines.push(cur);
         cur = w;
      }
   }
   if (cur) { lines.push(cur); }
   return lines.length ? lines : [''];
};

/** Render a wrapped multi-line note as content lines (each prefixed for readability). */
const noteLines = (note: string, prefix = ''): string[] => wrap(`${prefix}${note}`, W - 1).map((l) => line(l));

/** Format a web-vital metric value with its unit (ms vs unitless score), or "-" when null. */
const vitalValue = (m: DashboardWebVitals['metrics'][number]): string => {
   if (m.p75 === null) { return '-'; }
   return m.unit === 'ms' ? `${m.p75}ms` : String(m.p75);
};

/**
 * Render the dashboard plus suggested questions into one monospace text block.
 *
 * @param {Dashboard} d - The composed dashboard.
 * @param {SuggestedQuestion[]} questions - The contextual suggested questions.
 * @returns {string} A ready-to-show, box-drawn, ~78-col text block.
 */
const renderDashboard = (d: Dashboard, questions: SuggestedQuestion[]): string => {
   const out: string[] = [];

   // --- Title bar. ---
   out.push(rule('+', '=', '+'));
   out.push(line(`s33k OVERVIEW  ${d.domain}  (last ${d.period})`));
   out.push(rule('+', '=', '+'));

   // --- Headline: human visitors, AI referrals, top action. ---
   out.push(blank());
   out.push(line(`Human visitors: ${d.headline.humanVisitors}   AI-referred: ${d.headline.aiReferredVisitors}`));
   if (d.headline.topOpportunity) {
      out.push(blank());
      out.push(line('TOP OPPORTUNITY:'));
      noteLines(d.headline.topOpportunity, '  ').forEach((l) => out.push(l));
   }
   // The highlighted TOP ACTION callout: the single most useful next step.
   if (d.headline.topAction) {
      out.push(blank());
      out.push(rule('+', '-', '+'));
      out.push(line('>> TOP ACTION'));
      noteLines(d.headline.topAction, '   ').forEach((l) => out.push(l));
      out.push(rule('+', '-', '+'));
   }

   // --- TRAFFIC: top pages. ---
   out.push(section('TOP PAGES (by pageviews)'));
   if (d.topPages.note) {
      noteLines(d.topPages.note).forEach((l) => out.push(l));
   } else {
      out.push(line(`${padR('PAGE', 50)}${padL('VIEWS', 12)}${padL('ENTRIES', 14)}`.trimEnd()));
      d.topPages.data.forEach((p) => {
         out.push(line(`${padR(p.path, 50)}${padL(String(p.pageviews), 12)}${padL(String(p.entries), 14)}`));
      });
   }

   // --- TRAFFIC: top sources. ---
   out.push(section('TOP SOURCES'));
   if (d.topSources.data.note) {
      noteLines(d.topSources.data.note).forEach((l) => out.push(l));
   } else {
      d.topSources.data.byChannel.forEach((c) => {
         out.push(line(`${padR(c.channel, 62)}${padL(`${c.sessions} sess`, 15)}`));
      });
      if (d.topSources.data.topReferrers.length) {
         out.push(line('  referrers:'));
         d.topSources.data.topReferrers.forEach((r) => {
            const tag = r.isAI ? ' [AI]' : '';
            out.push(line(`    ${padR(`${r.name}${tag}`, 54)}${padL(`${r.visitors} vis`, 15)}`));
         });
      }
   }

   // --- SEO: rank distribution + top keywords. ---
   out.push(section('SEO RANK'));
   const rk = d.rankDistribution.data;
   if (d.rankDistribution.note) {
      noteLines(d.rankDistribution.note).forEach((l) => out.push(l));
   } else {
      out.push(line(`${rk.totalKeywords} tracked  |  top3: ${rk.inTop3}  top10: ${rk.inTop10}  `
         + `page1: ${rk.onPageOne}  not in top100: ${rk.notInTop100}`));
   }
   if (!d.topKeywords.note) {
      out.push(line('best-ranked:'));
      d.topKeywords.data.forEach((k) => {
         out.push(line(`  ${padL(`#${k.position}`, 5)}  ${padR(k.keyword, 67)}`));
      });
   } else {
      noteLines(d.topKeywords.note).forEach((l) => out.push(l));
   }

   // --- AEO: AI referrals per engine. ---
   out.push(section('AI SEARCH (referrals)'));
   if (d.aiReferrals.data.note) {
      noteLines(d.aiReferrals.data.note).forEach((l) => out.push(l));
   } else {
      out.push(line(`${d.aiReferrals.data.totalAiVisitors} AI-referred visitor(s):`));
      d.aiReferrals.data.byEngine.forEach((e) => {
         out.push(line(`  ${padR(e.engine, 58)}${padL(`${e.visitors} vis`, 15)}`));
      });
   }

   // --- ANALYTICS: web vitals. ---
   out.push(section('SITE SPEED (Core Web Vitals, p75)'));
   if (d.webVitals.data.note) {
      noteLines(d.webVitals.data.note).forEach((l) => out.push(l));
   } else {
      const withSamples = d.webVitals.data.metrics.filter((m) => m.sampleCount > 0);
      const shown = withSamples.length ? withSamples : d.webVitals.data.metrics;
      shown.forEach((m) => {
         const rating = m.rating ? m.rating : 'no data';
         out.push(line(`  ${padR(m.metric, 8)}${padR(vitalValue(m), 12)}${padR(rating, 22)}${padL(`${m.sampleCount} samples`, 26)}`));
      });
   }

   // --- CONVERSIONS: per goal (only when goals exist). ---
   if (d.conversions) {
      out.push(section('CONVERSIONS (by goal)'));
      if (d.conversions.note) {
         noteLines(d.conversions.note).forEach((l) => out.push(l));
      }
      if (d.conversions.data.length === 0 && !d.conversions.note) {
         out.push(line('No goals matched any sessions this period.'));
      }
      d.conversions.data.forEach((g) => {
         const val = g.value !== null ? `  $${g.value}/ea` : '';
         // Budget under 75 chars after the 2-space indent: 38 + 13 + 9 + up to ~12 for value.
         out.push(line(`  ${padR(g.goal, 38)}${padL(`${g.conversions} conv`, 13)}${padL(`${g.conversionRatePct}%`, 9)}${val}`));
      });
   }

   // --- WHAT CHANGED: biggest rank movers. ---
   out.push(section('WHAT CHANGED'));
   if (d.whatChanged.note) {
      noteLines(d.whatChanged.note).forEach((l) => out.push(l));
   } else {
      d.whatChanged.data.forEach((c) => {
         const arrow = c.kind === 'rank-improved' ? 'UP  ' : 'DOWN';
         out.push(line(`  ${arrow}  ${padR(c.keyword, 52)}${padL(`#${c.from} -> #${c.to}`, 16)}`));
      });
   }

   // --- TRY ASKING: the handholding suggested-question list. ---
   out.push(rule('+', '=', '+'));
   out.push(line('TRY ASKING (your AI can run any of these):'));
   out.push(blank());
   questions.forEach((q) => {
      out.push(line(`  * "${clip(q.question, W - 8)}"`));
      noteLines(q.why, `      ${''}`).forEach((l) => out.push(l));
   });
   out.push(blank());
   out.push(line('Say "show me my dashboard" anytime to see this overview again.'));
   out.push(rule('+', '=', '+'));

   return out.join('\n');
};

export { renderDashboard };
export default renderDashboard;
