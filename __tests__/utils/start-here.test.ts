/**
 * start-here PURE shaping layer: the gathering / rank-pending / honesty branches.
 *
 * These guard the "first try works, honestly" hardening:
 *   - seoTeaser must NOT say "0 on page one" while a first Google rank check is in progress.
 *   - the ready headline must lead with momentum when nothing has landed yet (gathering), not a
 *     flat "about 0 human visitor(s)".
 *   - whatYouCanSee only promises conversion reporting once a goal exists.
 *   - computeSetupState phrases track_keywords as "queued, first check running" when all keywords
 *     are still rank-pending, without changing done / percentComplete (parity with setup_status).
 * Pure: no DB, no network, no mocks needed.
 */
import {
   seoTeaser, whatYouCanSee, buildReady, computeSetupState, ReadyInput, ReportTeasers,
} from '../../utils/start-here';

const teasers: ReportTeasers = { analytics: 'a', seo: 's', aeo: 'e' };
const readyInput = (over: Partial<ReadyInput> = {}): ReadyInput => ({
   domain: 'driftwell.com',
   period: '30d',
   humanVisitors: 0,
   aiReferredVisitors: 0,
   topAction: 'Do the thing.',
   teasers,
   ...over,
});

describe('seoTeaser rank-pending branch', () => {
   it('says the first rank check is in progress, never "0 on page one", when rankPending', () => {
      const out = seoTeaser({ keywordsTracked: 5, onPageOne: 0, strikingDistance: 0, rankPending: true });
      expect(out).toContain('5 keyword(s) tracked');
      expect(out.toLowerCase()).toContain('first google rank check in progress');
      expect(out).not.toContain('on page one');
   });

   it('shows the normal counts once the check has landed (not pending)', () => {
      const out = seoTeaser({ keywordsTracked: 5, onPageOne: 2, strikingDistance: 1, rankPending: false });
      expect(out).toContain('2 on page one');
      expect(out).toContain('1 quick win(s)');
   });

   it('still tells an empty tracker to add keywords', () => {
      expect(seoTeaser({ keywordsTracked: 0, onPageOne: 0, strikingDistance: 0, rankPending: true }).toLowerCase())
         .toContain('no keywords tracked');
   });
});

describe('composeHeadline gathering-awareness (via buildReady)', () => {
   it('leads with momentum when no visitors and none AI-referred (brand-new site)', () => {
      const r = buildReady(readyInput({ humanVisitors: 0, aiReferredVisitors: 0 }));
      expect(r.headline.toLowerCase()).toContain('tracking is live');
      expect(r.headline.toLowerCase()).toContain('first numbers are coming in');
      expect(r.headline).not.toContain('about 0 human visitor');
   });

   it('keeps the real headline (with a rank-running note) when traffic exists but a rank check is pending', () => {
      const r = buildReady(readyInput({ humanVisitors: 12, aiReferredVisitors: 3, rankPending: true }));
      // Real numbers must NOT be hidden behind the gathering headline just because one new keyword is
      // still being rank-checked on an established site.
      expect(r.headline).toContain('about 12 human visitor(s)');
      expect(r.headline).toContain('3 AI-referred visitor(s)');
      expect(r.headline.toLowerCase()).toContain('first rank check is running');
      expect(r.headline.toLowerCase()).not.toContain('first numbers are coming in');
   });

   it('shows the real headline once a real number has landed', () => {
      const r = buildReady(readyInput({ humanVisitors: 40, aiReferredVisitors: 9 }));
      expect(r.headline).toContain('about 40 human visitor(s)');
      expect(r.headline).toContain('9 AI-referred visitor(s)');
   });
});

describe('whatYouCanSee conversion gating', () => {
   it('points the user at defining a goal when none exist', () => {
      const list = whatYouCanSee(0);
      expect(list.join(' ').toLowerCase()).toContain('define a conversion goal');
      expect(list.join(' ')).not.toContain('Conversions and revenue by source, including AI');
   });

   it('promises conversion reporting once a goal exists', () => {
      const list = whatYouCanSee(2);
      expect(list).toContain('Conversions and revenue by source, including AI');
   });

   it('buildReady threads goalCount through to whatYouCanSee', () => {
      expect(buildReady(readyInput({ goalCount: 0 })).whatYouCanSee.join(' ').toLowerCase())
         .toContain('define a conversion goal');
      expect(buildReady(readyInput({ goalCount: 1 })).whatYouCanSee)
         .toContain('Conversions and revenue by source, including AI');
   });
});

describe('computeSetupState track_keywords rank-pending wording', () => {
   const find = (s: ReturnType<typeof computeSetupState>) => s.steps.find((st) => st.key === 'track_keywords')!;

   it('says "queued, first Google rank check running" when all keywords are rank-pending', () => {
      const state = computeSetupState({ owned: true, keywordCount: 7, recentEvents: 0, goalCount: 0, keywordsRankPending: true });
      const step = find(state);
      expect(step.done).toBe(true);
      expect(step.detail.toLowerCase()).toContain('queued, first google rank check running');
   });

   it('keeps the plain "N keyword(s) tracked" wording when not pending (parity unchanged)', () => {
      const step = find(computeSetupState({ owned: true, keywordCount: 7, recentEvents: 0, goalCount: 0 }));
      expect(step.detail).toBe('7 keyword(s) tracked.');
      expect(step.done).toBe(true);
   });

   it('does not move done / percentComplete based on the pending flag', () => {
      const pending = computeSetupState({ owned: true, keywordCount: 3, recentEvents: 10, goalCount: 1, keywordsRankPending: true });
      const plain = computeSetupState({ owned: true, keywordCount: 3, recentEvents: 10, goalCount: 1 });
      expect(pending.percentComplete).toBe(plain.percentComplete);
      expect(pending.complete).toBe(plain.complete);
   });
});
