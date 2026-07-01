// Site audit: turn a site crawl into a prioritized on-page / technical SEO issue list.
//
// Given the page summaries from a site crawl (utils/site-crawl.ts), this runs a set of pure,
// deterministic rules over each page (and across pages) and returns the issues it finds, ranked by
// severity. It SUGGESTS fixes by naming the problem; it never edits a page and never calls an LLM.
// The thresholds below are the conventional SEO ranges (title 30 to 60 chars renders fully in the
// Google SERP; meta description ~120 to 160; every indexable page wants exactly one H1).

import type { PageSummary } from './site-crawl';

export type Severity = 'high' | 'medium' | 'low';

export type AuditIssue = {
   page: string,
   issue: string,
   severity: Severity,
   detail: string,
};

export type SiteAuditResult = {
   pagesAudited: number,
   issueCount: number,
   bySeverity: { high: number, medium: number, low: number },
   issues: AuditIssue[],
};

// SERP-render thresholds. Title past ~60 chars truncates in Google's results; under ~20 is usually
// too thin to describe the page. Meta description past ~160 truncates; under ~50 wastes the snippet.
const TITLE_MAX = 60;
const TITLE_MIN = 20;
const META_MAX = 160;
const META_MIN = 50;
// Excerpt length below which a page reads as "thin" (little indexable body text). The crawler caps
// the excerpt at 600 chars, so this is a floor on the visible-text signal, not a full word count.
const THIN_EXCERPT = 200;

// Sort high -> medium -> low so the most damaging issues surface first.
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Run the on-page SEO rule set over crawled page summaries and return a severity-sorted issue list.
 *
 * Per-page rules: missing/long/short title, missing/long/short meta description, missing H1, multiple
 * H1s, thin content. Cross-page rule: duplicate <title> shared by two or more pages. Pages the crawl
 * could not fetch (they carry their own error) are skipped, since absent fields there mean "unknown",
 * not "missing".
 * @param {PageSummary[]} pages - Page summaries from a site crawl.
 * @returns {SiteAuditResult} The audited issue list with severity counts.
 */
export const auditSite = (pages: PageSummary[]): SiteAuditResult => {
   const list = Array.isArray(pages) ? pages : [];
   const issues: AuditIssue[] = [];
   const push = (page: string, issue: string, severity: Severity, detail: string) =>
      issues.push({ page, issue, severity, detail });

   // Track titles across pages so duplicates can be flagged after the per-page pass. Keyed by the
   // normalized (trimmed, lowercased) title so trivial whitespace/case variants still count as dupes.
   const titleToPages = new Map<string, string[]>();

   // Only the pages the crawl actually fetched can be audited. A page with an "error" was unreachable,
   // so a blank title there is "we could not read it", not a real missing-title issue.
   const fetched = list.filter((p) => !p.error);

   for (const p of fetched) {
      const page = p.path || p.url || '';
      const title = String(p.title || '').trim();
      const meta = String(p.metaDescription || '').trim();
      const h1s = Array.isArray(p.h1) ? p.h1.filter((h) => String(h || '').trim()) : [];
      const excerpt = String(p.excerpt || '').trim();

      // Title. Missing is high (the single most important on-page tag); length issues are low because
      // the page still has a title, it just renders truncated or under-described in the SERP.
      if (!title) {
         push(page, 'Missing title', 'high',
            'The page has no <title> tag. Add a unique, descriptive title; it is the strongest on-page click signal.');
      } else {
         if (title.length > TITLE_MAX) {
            push(page, 'Title too long', 'low',
               `Title is ${title.length} chars (over ${TITLE_MAX}); Google truncates it. Tighten to ${TITLE_MAX} or fewer.`);
         } else if (title.length < TITLE_MIN) {
            push(page, 'Title too short', 'low',
               `Title is ${title.length} chars (under ${TITLE_MIN}); it under-describes the page. Expand to at least ${TITLE_MIN}.`);
         }
         const key = title.toLowerCase();
         titleToPages.set(key, [...(titleToPages.get(key) || []), page]);
      }

      // Meta description. Missing is medium (it does not directly rank but drives click-through);
      // length issues are low.
      if (!meta) {
         push(page, 'Missing meta description', 'medium',
            'No meta description. Add one (~120 to 160 chars) to control the SERP snippet and lift click-through.');
      } else if (meta.length > META_MAX) {
         push(page, 'Meta description too long', 'low',
            `Meta is ${meta.length} chars (over ${META_MAX}); the snippet truncates. Trim to ${META_MAX} or fewer.`);
      } else if (meta.length < META_MIN) {
         push(page, 'Meta description too short', 'low',
            `Meta is ${meta.length} chars (under ${META_MIN}); it wastes snippet space. Expand toward ${META_MIN} to ${META_MAX}.`);
      }

      // H1. Missing is high (no primary heading hurts both users and topical clarity); multiple H1s is
      // medium (ambiguous primary topic, a common template bug).
      if (h1s.length === 0) {
         push(page, 'Missing H1', 'high', 'The page has no H1 heading. Add exactly one H1 that states the page topic.');
      } else if (h1s.length > 1) {
         push(page, 'Multiple H1s', 'medium', `The page has ${h1s.length} H1 headings. Keep exactly one primary H1; demote the rest to H2.`);
      }

      // Thin content. Low severity: a short excerpt is a weak signal (the page may be image/app-heavy),
      // but it is worth surfacing because thin pages rarely rank.
      if (excerpt.length < THIN_EXCERPT) {
         push(page, 'Thin content', 'low',
            `Visible text is very short (${excerpt.length} chars sampled). Add substantive copy so the page has something to rank.`);
      }
   }

   // Cross-page: any non-empty title shared by two or more pages dilutes both. Flag every page in the
   // group (medium) so the fix list is actionable per-URL.
   for (const [, pagesWithTitle] of titleToPages) {
      if (pagesWithTitle.length > 1) {
         for (const page of pagesWithTitle) {
            push(page, 'Duplicate title', 'medium',
               `This <title> is shared by ${pagesWithTitle.length} pages (${pagesWithTitle.join(', ')}). Make each unique.`);
         }
      }
   }

   issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

   const bySeverity = { high: 0, medium: 0, low: 0 };
   for (const i of issues) { bySeverity[i.severity] += 1; }

   return {
      pagesAudited: fetched.length,
      issueCount: issues.length,
      bySeverity,
      issues,
   };
};
