import { sessionize, EventLike, GoalDef } from '../../utils/sessionize';
import { attributeConversions, AttribKeyword } from '../../utils/conversion-attribution';

const ev = (session: string, source: string, page: string, created: string): EventLike => ({
   session, source, is_bot: false, device: 'desktop', country: 'US', page, type: 'pageview', created,
});

const goal: GoalDef = { kind: 'page_reached', matchValue: '/thanks', matchPage: null, matchMode: 'prefix' };

const keywords: AttribKeyword[] = [
   { keyword: 'sales enablement software', position: 6, targetPage: '/sales-enablement-software' },
   { keyword: 'book a demo', position: 0, targetPage: '/demo' },
];

describe('attributeConversions (the cross-pillar join)', () => {
   // A,B,C organic land /sales-enablement-software and never convert; D,E are AI on /demo, D converts.
   const sessions = sessionize([
      ev('A', 'organic-search', '/sales-enablement-software', '...01'),
      ev('B', 'organic-search', '/sales-enablement-software', '...02'),
      ev('C', 'organic-search', '/sales-enablement-software', '...03'),
      ev('D', 'ai', '/demo', '...04'), ev('D', 'ai', '/thanks', '...05'),
      ev('E', 'ai', '/demo', '...06'),
   ]);
   const attr = attributeConversions(sessions, goal, keywords);

   it('computes overall + per-channel conversion rates', () => {
      expect(attr.totalSessions).toBe(5);
      expect(attr.conversions).toBe(1); // only D
      expect(attr.conversionRatePct).toBe(20);
      expect(attr.byChannel.find((c) => c.channel === 'organic-search')!.conversionRatePct).toBe(0);
      expect(attr.byChannel.find((c) => c.channel === 'ai')!.conversionRatePct).toBe(50);
   });

   it('credits each keyword page with the conversions it drove, carrying rank', () => {
      const k1 = attr.byKeyword.find((k) => k.keyword === 'sales enablement software')!;
      expect(k1.landingSessions).toBe(3);
      expect(k1.conversions).toBe(0);
      expect(k1.position).toBe(6);
      const k2 = attr.byKeyword.find((k) => k.keyword === 'book a demo')!;
      expect(k2.conversions).toBe(1);
   });

   it('surfaces the money moves', () => {
      const types = attr.opportunities.map((o) => o.type);
      expect(types).toContain('rank-not-converting'); // K1 ranks #6, 3 landings, 0 conversions
      expect(types).toContain('converting-not-ranking'); // K2 converts but ranks outside top 100
      expect(types).toContain('ai-outconverts-search'); // AI 50% vs organic 0%
   });

   it('omits revenue when no goal value is passed (unchanged shape)', () => {
      expect(attr.goalValue).toBeNull();
      expect(attr.totalRevenue).toBeNull();
      expect(attr.byChannel.every((c) => c.revenue === undefined)).toBe(true);
      expect(attr.byKeyword.every((k) => k.revenue === undefined)).toBe(true);
   });

   it('adds revenue (conversions * value) across totals, channels, and keywords when valued', () => {
      const valued = attributeConversions(sessions, goal, keywords, 250);
      expect(valued.goalValue).toBe(250);
      expect(valued.totalRevenue).toBe(250); // 1 conversion * 250
      expect(valued.byChannel.find((c) => c.channel === 'ai')!.revenue).toBe(250); // D converts on AI
      expect(valued.byChannel.find((c) => c.channel === 'organic-search')!.revenue).toBe(0);
      expect(valued.byKeyword.find((k) => k.keyword === 'book a demo')!.revenue).toBe(250);
   });
});
