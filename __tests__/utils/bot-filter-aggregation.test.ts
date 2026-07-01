import { isBotSegment, splitHumanBot, BotRow } from '../../utils/bot-filter';

/**
 * Additional unit coverage for the human-vs-bot heuristic, focused on the
 * task scenarios: a ~100%-bounce/low-duration row is a bot; an engaged or
 * long-duration row is a human; splitHumanBot aggregates totals correctly.
 * Pure, no network. Complements __tests__/utils/bot-filter.test.ts without
 * duplicating its assertions.
 */
describe('isBotSegment scenario coverage', () => {
   it('classifies a near-100% bounce, sub-15s row as bot', () => {
      // Mirrors real getmasset.com HK/SG/CN datacenter traffic.
      expect(isBotSegment({ name: 'HK', bounce_rate: 99.8, avg_duration: 3 })).toBe(true);
   });

   it('classifies a long-duration, low-bounce row as human', () => {
      expect(isBotSegment({ name: 'US', bounce_rate: 45, avg_duration: 120 })).toBe(false);
   });

   it('classifies a high-bounce but long-duration row as human', () => {
      // A reader who lands, reads for two minutes, then leaves is not a bot,
      // even at 100% bounce, because duration is well above the floor.
      expect(isBotSegment({ name: 'DE', bounce_rate: 100, avg_duration: 130 })).toBe(false);
   });

   it('classifies an engaged row as human even with no duration', () => {
      expect(isBotSegment({ name: 'CA', bounce_rate: 100, avg_duration: null, engaged: true })).toBe(false);
   });
});

describe('splitHumanBot aggregation', () => {
   it('aggregates visitor totals and bot share across a mixed set', () => {
      const rows: BotRow[] = [
         { name: 'HK', unique_visitors: 300, bounce_rate: 100, avg_duration: 2 }, // bot
         { name: 'CN', unique_visitors: 100, bounce_rate: 99.9, avg_duration: null }, // bot
         { name: 'US', unique_visitors: 80, bounce_rate: 40, avg_duration: 95 }, // human
         { name: 'linkedin', unique_visitors: 20, bounce_rate: 100, avg_duration: 0 }, // human floor
      ];
      const split = splitHumanBot(rows);
      expect(split.botVisitors).toBe(400);
      expect(split.humanVisitors).toBe(100);
      expect(split.totalVisitors).toBe(500);
      expect(split.botSharePct).toBe(80);
      expect(split.bot.map((r) => r.name)).toEqual(['HK', 'CN']);
      expect(split.human.map((r) => r.name)).toEqual(['US', 'linkedin']);
   });

   it('reports zero bot share when every segment is human', () => {
      const split = splitHumanBot([
         { name: 'US', unique_visitors: 50, bounce_rate: 30, avg_duration: 80 },
         { name: 'GB', unique_visitors: 25, bounce_rate: 50, avg_duration: 40 },
      ]);
      expect(split.botVisitors).toBe(0);
      expect(split.humanVisitors).toBe(75);
      expect(split.botSharePct).toBe(0);
   });

   it('reports 100% bot share when every segment is a bot', () => {
      const split = splitHumanBot([
         { name: 'HK', unique_visitors: 70, bounce_rate: 100, avg_duration: 1 },
         { name: 'SG', unique_visitors: 30, bounce_rate: 100, avg_duration: 0 },
      ]);
      expect(split.botVisitors).toBe(100);
      expect(split.botSharePct).toBe(100);
   });
});
