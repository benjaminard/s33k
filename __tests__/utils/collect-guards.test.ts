/**
 * Tests for utils/collect-guards.ts: bot detection, client-IP resolution, and the in-memory
 * rate limiter that protect the PUBLIC /api/collect ingest.
 */

import {
   isLikelyBotUA,
   clientIp,
   rateLimitCollect,
   __resetRateLimit,
   COLLECT_MAX_EVENTS,
   COLLECT_WINDOW_MS,
} from '../../utils/collect-guards';

describe('isLikelyBotUA', () => {
   it('treats a real browser UA as human', () => {
      const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
      expect(isLikelyBotUA(chrome)).toBe(false);
   });

   it('flags an empty or missing UA as a bot', () => {
      expect(isLikelyBotUA('')).toBe(true);
      expect(isLikelyBotUA(undefined)).toBe(true);
   });

   it('flags known AI crawlers and generic bot tooling', () => {
      expect(isLikelyBotUA('Mozilla/5.0 (compatible; GPTBot/1.0)')).toBe(true);
      expect(isLikelyBotUA('curl/8.4.0')).toBe(true);
      expect(isLikelyBotUA('python-requests/2.31')).toBe(true);
      expect(isLikelyBotUA('HeadlessChrome/120.0')).toBe(true);
   });
});

describe('clientIp (trusted-hop derivation)', () => {
   it('takes the RIGHTMOST (trusted-edge) x-forwarded-for hop, not the spoofable leftmost', () => {
      // Chain is `client, proxy1, proxy2`; with one trusted proxy the real client is the last hop.
      // The leftmost (203.0.113.5) is what an attacker could spoof, so it must NOT be returned.
      expect(clientIp({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18' })).toBe('70.41.3.18');
   });

   it('a single-hop chain yields that one hop', () => {
      expect(clientIp({ 'x-forwarded-for': '70.41.3.18' })).toBe('70.41.3.18');
   });

   it('honors TRUSTED_PROXY_HOPS for a deeper trusted topology', () => {
      const prev = process.env.TRUSTED_PROXY_HOPS;
      process.env.TRUSTED_PROXY_HOPS = '2';
      // Chain `client, edge1, edge2` with the two RIGHTMOST hops trusted: the real client is at
      // index length-2. The last two (8.8.8.8, 7.7.7.7) are the trusted edges; 9.9.9.9 is what the
      // client SENT (spoofable) and must NOT be returned. index 3-2 = 1 -> 8.8.8.8.
      expect(clientIp({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7' })).toBe('8.8.8.8');
      if (prev === undefined) { delete process.env.TRUSTED_PROXY_HOPS; } else { process.env.TRUSTED_PROXY_HOPS = prev; }
   });

   it('clamps to the first hop when the chain is shorter than the configured trusted-hop count', () => {
      const prev = process.env.TRUSTED_PROXY_HOPS;
      process.env.TRUSTED_PROXY_HOPS = '5';
      expect(clientIp({ 'x-forwarded-for': '5.5.5.5, 6.6.6.6' })).toBe('5.5.5.5');
      if (prev === undefined) { delete process.env.TRUSTED_PROXY_HOPS; } else { process.env.TRUSTED_PROXY_HOPS = prev; }
   });

   it('falls back to x-real-ip then the socket address', () => {
      expect(clientIp({ 'x-real-ip': '198.51.100.2' })).toBe('198.51.100.2');
      expect(clientIp({}, '192.0.2.9')).toBe('192.0.2.9');
      expect(clientIp({})).toBe('unknown');
   });
});

describe('rateLimitCollect', () => {
   beforeEach(() => { __resetRateLimit(); });

   it('allows events up to the per-window cap then rejects', () => {
      const now = 1_000_000;
      expect(rateLimitCollect('1.1.1.1', 'a.com', COLLECT_MAX_EVENTS, now)).toBe(true);
      // One more event in the same window is over the cap.
      expect(rateLimitCollect('1.1.1.1', 'a.com', 1, now + 10)).toBe(false);
   });

   it('resets after the window elapses', () => {
      const now = 2_000_000;
      expect(rateLimitCollect('2.2.2.2', 'b.com', COLLECT_MAX_EVENTS, now)).toBe(true);
      expect(rateLimitCollect('2.2.2.2', 'b.com', 1, now + 10)).toBe(false);
      // After the window, the counter resets.
      expect(rateLimitCollect('2.2.2.2', 'b.com', 1, now + COLLECT_WINDOW_MS + 1)).toBe(true);
   });

   it('scopes the window per ip+domain', () => {
      const now = 3_000_000;
      expect(rateLimitCollect('3.3.3.3', 'c.com', COLLECT_MAX_EVENTS, now)).toBe(true);
      // A different domain (or ip) has its own fresh budget.
      expect(rateLimitCollect('3.3.3.3', 'd.com', 5, now + 10)).toBe(true);
   });
});
