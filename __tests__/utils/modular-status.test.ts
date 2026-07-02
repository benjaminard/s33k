/**
 * Modular pillar status: computeModules + the seoEnabled dimension of computeSetupState.
 *
 * The headless-direction contract: the instance is described as MODULES. Analytics is live once
 * beacon events flow; AI referrals ride analytics; SEO is enabled iff a scraper key is
 * configured, otherwise "not enabled" WITH the mint_key_drop enablement path. The load-bearing
 * rule: a KEYLESS instance with flowing analytics reads as HEALTHY/complete (an optional module
 * off), never as incomplete setup, while legacy behavior (seoEnabled omitted) stays byte-for-byte.
 */
import { computeModules, computeSetupState } from '../../utils/start-here';

describe('computeModules', () => {
   it('keyless with flowing analytics: analytics + AI referrals live, SEO not enabled with the enablement path', () => {
      const modules = computeModules({ recentEvents: 42, seoEnabled: false, keywordCount: 0 });
      const byKey = Object.fromEntries(modules.map((m) => [m.key, m]));
      expect(byKey.analytics.status).toBe('live');
      expect(byKey.ai_referrals.status).toBe('live');
      expect(byKey.seo.status).toBe('not_enabled');
      expect(byKey.seo.detail).toContain('optional');
      expect(byKey.seo.enable).toContain('mint_key_drop');
      expect(byKey.seo.enable).toContain('never passes through this chat');
   });

   it('keyed instance: SEO enabled (with the keyword count), no enable path needed', () => {
      const modules = computeModules({ recentEvents: 42, seoEnabled: true, keywordCount: 7 });
      const seo = modules.find((m) => m.key === 'seo')!;
      expect(seo.status).toBe('enabled');
      expect(seo.detail).toContain('7 keyword(s)');
      expect(seo.enable).toBeUndefined();
   });

   it('truly fresh instance (no events yet): analytics + AI referrals wait for the beacon', () => {
      const modules = computeModules({ recentEvents: 0, seoEnabled: false, keywordCount: 0 });
      const byKey = Object.fromEntries(modules.map((m) => [m.key, m]));
      expect(byKey.analytics.status).toBe('waiting_for_beacon');
      expect(byKey.ai_referrals.status).toBe('waiting_for_beacon');
      expect(byKey.seo.status).toBe('not_enabled');
   });
});

describe('computeSetupState with the SEO module OFF (seoEnabled: false)', () => {
   it('a keyless instance with flowing analytics + goals is COMPLETE (healthy, module off)', () => {
      const state = computeSetupState({
         owned: true, keywordCount: 0, recentEvents: 100, goalCount: 1, domain: 'x.com', seoEnabled: false,
      });
      expect(state.complete).toBe(true);
      expect(state.percentComplete).toBe(100);
      expect(state.nextStep).toBeNull();
      // The keywords step is OMITTED, not shown undone: an off module is not missing setup.
      expect(state.steps.find((s) => s.key === 'track_keywords')).toBeUndefined();
   });

   it('first_report no longer requires keywords when SEO is off', () => {
      const state = computeSetupState({
         owned: true, keywordCount: 0, recentEvents: 5, goalCount: 0, domain: 'x.com', seoEnabled: false,
      });
      expect(state.steps.find((s) => s.key === 'first_report')!.done).toBe(true);
      // Goals remain a real (module-independent) step, same as a keyed instance.
      expect(state.nextStep!.key).toBe('define_goals');
   });

   it('a truly unconfigured keyless instance still walks onboarding (add site first)', () => {
      const state = computeSetupState({
         owned: false, keywordCount: 0, recentEvents: 0, goalCount: 0, domain: 'new.com', seoEnabled: false,
      });
      expect(state.complete).toBe(false);
      expect(state.nextStep!.key).toBe('add_domain');
   });
});

describe('computeSetupState legacy behavior (seoEnabled omitted or true) is unchanged', () => {
   it('omitted: five steps, keywords still required for completion', () => {
      const state = computeSetupState({
         owned: true, keywordCount: 0, recentEvents: 100, goalCount: 1, domain: 'x.com',
      });
      expect(state.steps).toHaveLength(5);
      expect(state.complete).toBe(false);
      expect(state.nextStep!.key).toBe('track_keywords');
   });

   it('true: identical to omitted', () => {
      const omitted = computeSetupState({ owned: true, keywordCount: 3, recentEvents: 9, goalCount: 1, domain: 'x.com' });
      const explicit = computeSetupState({
         owned: true, keywordCount: 3, recentEvents: 9, goalCount: 1, domain: 'x.com', seoEnabled: true,
      });
      expect(explicit).toEqual(omitted);
      expect(explicit.complete).toBe(true);
   });
});
