import {
   isBotSegment, splitHumanBot, isHumanReferrer, estimateHumanTraffic, firstPartyHumanTraffic,
   BOUNCE_MIN, DURATION_MAX, BotRow,
} from '../../utils/bot-filter';
import type { AnalyticsProvider } from '../../utils/analytics';
import type { SessionAgg } from '../../utils/sessionize';

// Minimal SessionAgg factory: only is_bot matters for the human-vs-bot split.
const sess = (isBot: boolean, id = String(Math.random())): SessionAgg => ({
   id,
   channel: 'direct',
   isBot,
   device: '',
   country: '',
   landingPage: '/',
   exitPage: '/',
   pageviewPaths: ['/'],
   eventTypes: new Set(['pageview']),
   pageEvents: [],
   pageviewCount: 1,
   hasNonPageviewEvent: false,
});

// A provider whose page rows carry NULL bounce_rate (the Umami shape that caused the 0-bots bug),
// plus a real summary visitor total. getReferralSources is empty.
const nullBounceProvider = (): AnalyticsProvider => ({
   getSummary: async () => ({ pageviews: 900, visitors: 721, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null }),
   getPageTraffic: async () => ({
      pages: [
         { url: '/', pathClean: '/', pageviews: 500, unique_visitors: 400, bounce_rate: null, avg_duration: null },
         { url: '/pricing', pathClean: '/pricing', pageviews: 400, unique_visitors: 321, bounce_rate: null, avg_duration: null },
      ],
      error: null,
   }),
   getReferralSources: async () => ({ sources: [], error: null }),
} as unknown as AnalyticsProvider);

describe('isBotSegment', () => {
   it('flags ~100% bounce with near-zero duration as bot', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: 2 })).toBe(true);
      expect(isBotSegment({ bounce_rate: BOUNCE_MIN, avg_duration: DURATION_MAX - 0.1 })).toBe(true);
   });

   it('treats a null duration at high bounce as bot (single-hit bounce)', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: null })).toBe(true);
      expect(isBotSegment({ bounce_rate: 100 })).toBe(true);
   });

   it('does not flag when bounce is below the threshold', () => {
      expect(isBotSegment({ bounce_rate: 98, avg_duration: 1 })).toBe(false);
   });

   it('does not flag when duration is at/above the threshold', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: DURATION_MAX })).toBe(false);
      expect(isBotSegment({ bounce_rate: 100, avg_duration: 60 })).toBe(false);
   });

   it('treats a missing bounce_rate as human (no behavioral evidence)', () => {
      expect(isBotSegment({ avg_duration: 1 })).toBe(false);
      expect(isBotSegment({ bounce_rate: null, avg_duration: 1 })).toBe(false);
   });

   it('honors the engaged human floor even at 100% bounce', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: 1, engaged: true })).toBe(false);
   });

   it('honors the known-human referrer floor even at 100% bounce', () => {
      expect(isBotSegment({ name: 'google', bounce_rate: 100, avg_duration: 1 })).toBe(false);
      expect(isBotSegment({ name: 'chatgpt.com', bounce_rate: 100, avg_duration: 0 })).toBe(false);
      expect(isBotSegment({ isAI: true, bounce_rate: 100, avg_duration: 0 })).toBe(false);
      expect(isBotSegment({ source_type: 'search', bounce_rate: 100, avg_duration: 0 })).toBe(false);
   });

   it('never throws on bad input', () => {
      expect(isBotSegment(null as unknown as BotRow)).toBe(false);
      expect(isBotSegment({ bounce_rate: NaN, avg_duration: NaN })).toBe(false);
   });
});

describe('isHumanReferrer', () => {
   it('matches AI flag, human source types, and name hints', () => {
      expect(isHumanReferrer({ isAI: true })).toBe(true);
      expect(isHumanReferrer({ source_type: 'social' })).toBe(true);
      expect(isHumanReferrer({ name: 'LinkedIn' })).toBe(true);
      expect(isHumanReferrer({ name: 'somerandomscraper.io' })).toBe(false);
      expect(isHumanReferrer({})).toBe(false);
   });
});

describe('splitHumanBot', () => {
   it('splits rows and sums unique_visitors on each side', () => {
      const rows: BotRow[] = [
         { name: 'HK', unique_visitors: 100, bounce_rate: 100, avg_duration: 1 }, // bot
         { name: 'SG', unique_visitors: 50, bounce_rate: 99.5, avg_duration: null }, // bot
         { name: 'US', unique_visitors: 40, bounce_rate: 60, avg_duration: 90 }, // human
         { name: 'google', unique_visitors: 10, bounce_rate: 100, avg_duration: 0 }, // human floor
      ];
      const split = splitHumanBot(rows);
      expect(split.botVisitors).toBe(150);
      expect(split.humanVisitors).toBe(50);
      expect(split.totalVisitors).toBe(200);
      expect(split.botSharePct).toBe(75);
      expect(split.bot).toHaveLength(2);
      expect(split.human).toHaveLength(2);
   });

   it('returns an all-zero split for empty or bad input', () => {
      const empty = splitHumanBot([]);
      expect(empty.botSharePct).toBe(0);
      expect(empty.totalVisitors).toBe(0);
      const bad = splitHumanBot(null as unknown as BotRow[]);
      expect(bad.botVisitors).toBe(0);
   });

   it('ignores negative or non-finite visitor counts', () => {
      const split = splitHumanBot([
         { unique_visitors: -5, bounce_rate: 100, avg_duration: 1 },
         { unique_visitors: 10, bounce_rate: 100, avg_duration: 1 },
      ]);
      expect(split.botVisitors).toBe(10);
   });
});

describe('firstPartyHumanTraffic', () => {
   it('reports the exact is_bot split from first-party sessions', () => {
      const sessions = [sess(false), sess(false), sess(false), sess(true)]; // 3 human, 1 bot
      const est = firstPartyHumanTraffic(sessions);
      expect(est.estVisitors).toBe(4);
      expect(est.estHumanVisitors).toBe(3);
      expect(est.estBotVisitors).toBe(1);
      expect(est.botSharePct).toBe(25);
      expect(est.botEstimationAvailable).toBe(true);
      expect(est.method).toMatch(/first-party/i);
      expect(est.method).not.toMatch(/umami|lodd/i);
   });
});

describe('estimateHumanTraffic', () => {
   it('uses the first-party split when sessions are supplied, ignoring the provider entirely', async () => {
      // 177 humans / 544 bots = the real getmasset.com shape that start_here reports.
      const sessions: SessionAgg[] = [];
      for (let i = 0; i < 177; i += 1) { sessions.push(sess(false, `h${i}`)); }
      for (let i = 0; i < 544; i += 1) { sessions.push(sess(true, `b${i}`)); }
      const est = await estimateHumanTraffic(nullBounceProvider(), 'getmasset.com', '30d', sessions);
      expect(est.estHumanVisitors).toBe(177);
      expect(est.estBotVisitors).toBe(544);
      expect(est.estVisitors).toBe(721);
      expect(est.botEstimationAvailable).toBe(true);
      expect(est.botSharePct).toBeGreaterThan(0); // NOT a fabricated 0
   });

   it('does NOT return 0 bots / 100% human when all provider page rows have null bounce_rate', async () => {
      // The regression guard: with NO first-party sessions and a null-bounce provider (Umami), the old
      // behavioral heuristic short-circuited every row to human and fabricated 0 bots / 100% human.
      // The fix returns an HONEST degraded shape instead: botSharePct null, botEstimationAvailable false.
      const est = await estimateHumanTraffic(nullBounceProvider(), 'getmasset.com', '30d');
      // botEstimationAvailable:false is the authoritative "no split computed" signal. estBotVisitors 0
      // here means "declined to guess", NOT "no bots found", and estVisitors 0 keeps it from reading as
      // a real "100% human" anywhere downstream. The old bug returned a fabricated 0-bots / 100%-human.
      expect(est.botEstimationAvailable).toBe(false);
      expect(est.estBotVisitors).toBe(0);
      expect(est.estHumanVisitors).toBe(0);
      expect(est.estVisitors).toBe(0); // not summary.visitors, so it cannot imply "0 bots of 721"
      expect(est.method).not.toMatch(/umami|lodd/i);
      expect(est.method).toMatch(/first-party tracking|active analytics provider/i);
   });

   it('still uses the behavioral fallback for a provider that DOES expose page-grain bounce', async () => {
      const loddShape = {
         getSummary: async () => ({ pageviews: 200, visitors: 100, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null }),
         getPageTraffic: async () => ({
            pages: [{ url: '/', pathClean: '/', pageviews: 100, unique_visitors: 100, bounce_rate: 100, avg_duration: 1 }],
            error: null,
         }),
         getReferralSources: async () => ({ sources: [], error: null }),
      } as unknown as AnalyticsProvider;
      const est = await estimateHumanTraffic(loddShape, 'x.com', '30d');
      expect(est.botEstimationAvailable).toBe(true);
      expect(est.botSharePct).not.toBeNull();
      expect(est.estBotVisitors).toBeGreaterThan(0);
      expect(est.method).toMatch(/behavioral/i);
   });
});

// Cross-view agreement: human_traffic (first-party path), human_analytics, and start_here all derive
// the human number from the SAME is_bot tally via humanBotSplit, so they must report the SAME count
// from one event stream. This asserts the single-source-of-truth contract at the helper level.
describe('cross-view human-count agreement', () => {
   // eslint-disable-next-line global-require
   const { humanBotSplit, sessionize } = require('../../utils/sessionize');

   it('human_traffic, human_analytics, and start_here report the SAME human count from one fixture stream', async () => {
      // One raw event stream: 3 human sessions, 2 bot sessions (5 distinct sessions, one pageview each).
      const mk = (session: string, isBot: boolean) => ({
         session, source: null, is_bot: isBot, device: 'desktop', country: 'US', page: '/', type: 'pageview', created: '2026-06-20T00:00:00.000Z',
      });
      const rows = [mk('s1', false), mk('s2', false), mk('s3', false), mk('b1', true), mk('b2', true)];
      const sessions = sessionize(rows);

      // The number human_analytics / start_here / dashboard compute (via the shared helper).
      const sharedHuman = humanBotSplit(sessions).human;
      // The number human_traffic now computes (first-party path through estimateHumanTraffic).
      const httEst = await estimateHumanTraffic(nullBounceProvider(), 'getmasset.com', '30d', sessions);

      expect(sharedHuman).toBe(3);
      expect(httEst.estHumanVisitors).toBe(3);
      expect(httEst.estHumanVisitors).toBe(sharedHuman);
   });
});
