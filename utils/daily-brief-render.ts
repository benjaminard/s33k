/*
 * ============================================================================
 * s33k DAILY BRIEF RENDERER: two views of one composed brief (PURE).
 * ============================================================================
 * A composed DailyBrief (utils/daily-brief.ts) is rendered two ways:
 *   1. renderDailyBriefText: a compact, monospace, box-drawn block for the LLM /
 *      terminal / chat. It mirrors the dashboard renderer's MS-DOS aesthetic
 *      (utils/dashboard-render.ts) but is SHORT: a standup, not a full overview.
 *   2. renderDailyBriefHtml: a clean, self-contained HTML block for the scheduled
 *      email. Email clients strip <style>/<head> and most CSS, so every style is
 *      INLINE on the element (the same hard constraint generateEmail.ts works
 *      under). The palette matches s33k's dark "telemetry console" brand.
 *
 * Both are PURE (no IO, no LLM) and both ESCAPE all interpolated brief text, so a
 * keyword, page path, or recommendation that happens to contain HTML can never
 * break the email layout or inject markup.
 * ============================================================================
 */

import type { DailyBrief, DailyBriefChange } from './daily-brief';

// --- Shared: escape any interpolated text so brief content cannot inject HTML. ----
const escapeHtml = (s: string): string => String(s ?? '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#39;');

// ============================================================================
// TEXT (monospace, box-drawn, ~78 cols). Mirrors dashboard-render but SHORT.
// ============================================================================

const W = 78;

/** Truncate to n chars with a trailing ".." when cut, so a long line never overflows the box. */
const clip = (s: string, n: number): string => {
   const str = String(s ?? '');
   if (str.length <= n) { return str; }
   if (n <= 2) { return str.slice(0, n); }
   return `${str.slice(0, n - 2)}..`;
};

/** Pad a string to width n on the right (left-aligned). Truncates if too long. */
const padR = (s: string, n: number): string => clip(s, n).padEnd(n, ' ');

/** A full horizontal rule: left-corner, fill, right-corner. */
const rule = (left: string, fill: string, right: string): string => `${left}${fill.repeat(W)}${right}`;

/** A content line: vertical bar, padded text to W, vertical bar. */
const line = (text: string): string => `|${padR(` ${text}`, W)}|`;

/** A blank content line. */
const blank = (): string => `|${' '.repeat(W)}|`;

/** Wrap a long string into lines of at most `width` content chars. */
const wrap = (text: string, width: number): string[] => {
   const words = String(text ?? '').split(/\s+/).filter(Boolean);
   const lines: string[] = [];
   let cur = '';
   for (const w of words) {
      if (!cur) { cur = w; } else if (`${cur} ${w}`.length <= width) { cur = `${cur} ${w}`; } else { lines.push(cur); cur = w; }
   }
   if (cur) { lines.push(cur); }
   return lines.length ? lines : [''];
};

/** Render a wrapped multi-line string as content lines (each optionally prefixed). */
const noteLines = (note: string, prefix = ''): string[] => wrap(`${prefix}${note}`, W - 1).map((l) => line(l));

/** A short severity tag for the monospace view, e.g. "[HIGH]". */
const sevTag = (c: DailyBriefChange): string => `[${c.severity.toUpperCase()}]`;

/**
 * Render the brief as a compact monospace block. SHORT by design: a title bar, the
 * one-line HEADLINE, the few WHAT CHANGED bullets (or an honest quiet line), and the
 * single highlighted TOP ACTION. No per-pillar dump: that is what the dashboard is for.
 * @param {DailyBrief} b - The composed brief.
 * @returns {string} A ready-to-show, box-drawn, ~78-col text block.
 */
export const renderDailyBriefText = (b: DailyBrief): string => {
   const out: string[] = [];

   out.push(rule('+', '=', '+'));
   out.push(line(`s33k DAILY BRIEF  ${b.domain}  (last ${b.period})`));
   out.push(rule('+', '=', '+'));

   // HEADLINE: the single most important thing right now.
   out.push(blank());
   out.push(line('HEADLINE:'));
   noteLines(b.headline, '  ').forEach((l) => out.push(l));

   // WHAT CHANGED: the top few period-over-period shifts, or an honest quiet line.
   out.push(rule('+', '-', '+'));
   out.push(line('WHAT CHANGED'));
   if (b.whatChanged.length === 0) {
      noteLines('Quiet period: nothing material changed versus the prior window.', '  ').forEach((l) => out.push(l));
   } else {
      b.whatChanged.forEach((c) => {
         noteLines(`${sevTag(c)} ${c.text}`, '  ').forEach((l) => out.push(l));
      });
   }

   // TOP ACTION: the single highlighted next move.
   out.push(rule('+', '-', '+'));
   out.push(line('>> TOP ACTION'));
   noteLines(b.topAction, '   ').forEach((l) => out.push(l));
   out.push(rule('+', '=', '+'));

   return out.join('\n');
};

// ============================================================================
// HTML (inline styles only, dark telemetry-console palette). For the email.
// ============================================================================

// The s33k email palette, kept together so it is easy to audit. Dark surface, light
// text, one accent. Severity colors echo the analyst's high/medium/low.
const BG = '#0b1020';
const PANEL = '#121a30';
const TEXT = '#e6edf6';
const MUTED = '#9fb0c8';
const ACCENT = '#5ed7c3';
const HAIRLINE = '#26324d';
const SEV_COLOR: Record<DailyBriefChange['severity'], string> = {
   high: '#fca5a5',
   medium: '#fcd34d',
   low: '#9fb0c8',
};

/** A single "what changed" row as an inline-styled table row. */
const htmlChangeRow = (c: DailyBriefChange): string => {
   const color = SEV_COLOR[c.severity];
   const sev = escapeHtml(c.severity.toUpperCase());
   const pillar = escapeHtml(c.pillar);
   const text = escapeHtml(c.text);
   return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid ${HAIRLINE};vertical-align:top;">
         <span style="display:inline-block;min-width:64px;font-size:11px;font-weight:700;color:${color};`
      + `letter-spacing:0.5px;">${sev}</span>
         <span style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:0.5px;">${pillar}</span>
         <div style="font-size:14px;color:${TEXT};line-height:1.5;margin-top:2px;">${text}</div>
      </td>
   </tr>`;
};

/**
 * Render the brief as a clean, self-contained HTML block for the scheduled email.
 * Inline styles only (email clients strip <style>), all interpolated text escaped.
 * It is a fragment (no <html>/<body>) so the caller can wrap or send it directly.
 * @param {DailyBrief} b - The composed brief.
 * @returns {string} An inline-styled HTML block.
 */
export const renderDailyBriefHtml = (b: DailyBrief): string => {
   const domain = escapeHtml(b.domain);
   const period = escapeHtml(b.period);
   const headline = escapeHtml(b.headline);
   const topAction = escapeHtml(b.topAction);

   // Short, repeated inline-style fragments, kept as named constants so each markup line below
   // stays under the 150-char cap and reads cleanly. Email clients strip <style>, so every visual
   // rule has to live inline on the element.
   const eyebrow = (color: string): string => `font-size:11px;color:${color};text-transform:uppercase;letter-spacing:1px;font-weight:700;`;
   const outerStyle = `background:${BG};padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;`;
   const cardStyle = `width:600px;max-width:600px;background:${PANEL};border:1px solid ${HAIRLINE};border-radius:10px;`;
   const actionBox = `background:${BG};border:1px solid ${ACCENT};border-radius:8px;`;
   const footerStyle = `font-size:11px;color:${MUTED};line-height:1.5;border-top:1px solid ${HAIRLINE};padding-top:14px;`;
   const quietRow = `padding:8px 0;font-size:14px;color:${MUTED};line-height:1.5;`;

   const changesHtml = b.whatChanged.length === 0
      ? `<tr><td style="${quietRow}">Quiet period: nothing material changed versus the prior window.</td></tr>`
      : b.whatChanged.map(htmlChangeRow).join('');

   const footerText = 'Composed by s33k from your own SEO, AI search, and analytics data. '
      + 'No AI model was called and your data never leaves your instance to train one.';

   // 600px centered card (the email-safe width), built as an array of clean markup parts and joined.
   // Keeping each part a self-contained line avoids fragile multi-line strings and the line-length cap.
   const parts: string[] = [
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${outerStyle}">`,
      '<tr><td align="center">',
      `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="${cardStyle}">`,
      '<tr><td style="padding:24px 28px 8px 28px;">',
      `<div style="${eyebrow(ACCENT)}letter-spacing:1.5px;">s33k Daily Brief</div>`,
      `<div style="font-size:18px;color:${TEXT};font-weight:700;margin-top:4px;">${domain}</div>`,
      `<div style="font-size:12px;color:${MUTED};margin-top:2px;">Last ${period}</div>`,
      '</td></tr>',
      '<tr><td style="padding:8px 28px 0 28px;">',
      `<div style="${eyebrow(MUTED)}">Headline</div>`,
      `<div style="font-size:16px;color:${TEXT};line-height:1.5;margin-top:6px;">${headline}</div>`,
      '</td></tr>',
      '<tr><td style="padding:18px 28px 0 28px;">',
      `<div style="${eyebrow(MUTED)}">What Changed</div>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">${changesHtml}</table>`,
      '</td></tr>',
      '<tr><td style="padding:18px 28px 24px 28px;">',
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${actionBox}">`,
      '<tr><td style="padding:14px 16px;">',
      `<div style="${eyebrow(ACCENT)}">Top Action</div>`,
      `<div style="font-size:14px;color:${TEXT};line-height:1.6;margin-top:6px;">${topAction}</div>`,
      '</td></tr></table>',
      '</td></tr>',
      '<tr><td style="padding:0 28px 24px 28px;">',
      `<div style="${footerStyle}">${footerText}</div>`,
      '</td></tr>',
      '</table>',
      '</td></tr>',
      '</table>',
   ];
   return parts.join('\n');
};

export default renderDailyBriefText;
