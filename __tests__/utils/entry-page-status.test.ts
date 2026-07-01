/**
 * Tests for the pure entry-page status classifier (utils/entry-page-status.ts).
 *
 * The classifier is the synthesis at the heart of the entry_pages feature: it turns
 * three joined booleans (tracks ranking keywords / has non-direct entry traffic / has
 * AI first-touch) into one of five actionable statuses. Because it is pure, every
 * combination is exhaustively pinned here so the route and the MCP tool can rely on a
 * single, tested definition.
 */

import {
   classifyEntryPage, EntryPageStatus, ENTRY_PAGE_STATUS_LABELS,
} from '../../utils/entry-page-status';

describe('classifyEntryPage: the five-status synthesis', () => {
   it('ai-landing wins first when AI is a meaningful first-touch source', () => {
      // AI takes precedence even when the page also ranks and has other traffic.
      expect(classifyEntryPage({ hasTrackedKeywords: true, hasNonDirectTraffic: true, hasAiTraffic: true })).toBe('ai-landing');
      expect(classifyEntryPage({ hasTrackedKeywords: false, hasNonDirectTraffic: false, hasAiTraffic: true })).toBe('ai-landing');
   });

   it('working = ranks AND lands from search/referral (no AI)', () => {
      expect(classifyEntryPage({ hasTrackedKeywords: true, hasNonDirectTraffic: true, hasAiTraffic: false })).toBe('working');
   });

   it('ranking-not-landing = ranks but no non-direct entry traffic (the gap to fix)', () => {
      expect(classifyEntryPage({ hasTrackedKeywords: true, hasNonDirectTraffic: false, hasAiTraffic: false })).toBe('ranking-not-landing');
   });

   it('brand-direct = lands from non-direct traffic but no tracked ranking', () => {
      expect(classifyEntryPage({ hasTrackedKeywords: false, hasNonDirectTraffic: true, hasAiTraffic: false })).toBe('brand-direct');
   });

   it('opportunity = entry traffic but neither ranking nor AI', () => {
      expect(classifyEntryPage({ hasTrackedKeywords: false, hasNonDirectTraffic: false, hasAiTraffic: false })).toBe('opportunity');
   });

   it('is exhaustive: every one of the 8 boolean combinations maps to exactly one valid status', () => {
      const valid: EntryPageStatus[] = ['working', 'ranking-not-landing', 'brand-direct', 'ai-landing', 'opportunity'];
      const bools = [true, false];
      bools.forEach((hasTrackedKeywords) => {
         bools.forEach((hasNonDirectTraffic) => {
            bools.forEach((hasAiTraffic) => {
               const status = classifyEntryPage({ hasTrackedKeywords, hasNonDirectTraffic, hasAiTraffic });
               expect(valid).toContain(status);
            });
         });
      });
   });

   it('coerces non-boolean / undefined signals without throwing', () => {
      // The route passes computed booleans, but the classifier must be robust.
      const status = classifyEntryPage({
         hasTrackedKeywords: undefined as unknown as boolean,
         hasNonDirectTraffic: 1 as unknown as boolean,
         hasAiTraffic: 0 as unknown as boolean,
      });
      // tracked=falsey, nonDirect=truthy, ai=falsey -> brand-direct.
      expect(status).toBe('brand-direct');
   });

   it('exposes a human-readable label for every status', () => {
      const statuses: EntryPageStatus[] = ['working', 'ranking-not-landing', 'brand-direct', 'ai-landing', 'opportunity'];
      statuses.forEach((s) => {
         expect(ENTRY_PAGE_STATUS_LABELS[s].length).toBeGreaterThan(10);
      });
   });
});
