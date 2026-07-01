import {
   sessionize, applyFilters, sessionConverted, normalizeChannel, canonicalChannel, EventLike,
} from '../../utils/sessionize';

const ev = (o: Partial<EventLike>): EventLike => ({
   session: 'A', source: 'direct', is_bot: false, device: 'desktop', country: 'US',
   page: '/', type: 'pageview', created: '2026-06-16T10:00:00.000Z', ...o,
});

describe('normalizeChannel / canonicalChannel', () => {
   it('normalizes stored source to a channel', () => {
      expect(normalizeChannel('organic-search')).toBe('organic-search');
      expect(normalizeChannel('ai')).toBe('ai');
      expect(normalizeChannel('')).toBe('direct');
      expect(normalizeChannel(null)).toBe('direct');
      expect(normalizeChannel('blog.example.com')).toBe('referral'); // bare host
   });
   it('maps user aliases to canonical channels', () => {
      expect(canonicalChannel('seo')).toBe('organic-search');
      expect(canonicalChannel('organic')).toBe('organic-search');
      expect(canonicalChannel('aio')).toBe('ai');
      expect(canonicalChannel('ai-search')).toBe('ai');
      expect(canonicalChannel('direct')).toBe('direct');
   });
});

describe('sessionize', () => {
   it('groups by session and derives landing/exit page, dimensions, and event set', () => {
      const rows: EventLike[] = [
         ev({ session: 'A', page: '/', type: 'pageview', created: '...10:00' }),
         ev({ session: 'A', page: '/pricing', type: 'pageview', created: '...10:01' }),
         ev({ session: 'A', page: '/pricing', type: 'form_submit', created: '...10:02' }),
         ev({ session: 'B', page: '/blog', type: 'pageview', source: 'organic-search', created: '...10:03' }),
      ];
      const sessions = sessionize(rows);
      const a = sessions.find((s) => s.id === 'A')!;
      expect(a.landingPage).toBe('/');
      expect(a.exitPage).toBe('/pricing');
      expect(a.pageviewCount).toBe(2);
      expect(a.hasNonPageviewEvent).toBe(true);
      expect(a.eventTypes.has('form_submit')).toBe(true);
      const b = sessions.find((s) => s.id === 'B')!;
      expect(b.channel).toBe('organic-search');
      expect(b.pageviewCount).toBe(1);
      expect(b.hasNonPageviewEvent).toBe(false);
   });
});

describe('applyFilters', () => {
   const sessions = sessionize([
      ev({ session: 'A', source: 'organic-search', device: 'mobile', country: 'US', page: '/', type: 'pageview' }),
      ev({ session: 'B', source: 'ai', device: 'desktop', country: 'GB', page: '/x', type: 'pageview', is_bot: true }),
      ev({ session: 'C', source: 'direct', device: 'mobile', country: 'US', page: '/', type: 'pageview' }),
   ]);
   it('humanOnly excludes bot sessions', () => {
      expect(applyFilters(sessions, { humanOnly: true }).map((s) => s.id).sort()).toEqual(['A', 'C']);
   });
   it('channel + device + country compose', () => {
      expect(applyFilters(sessions, { channel: 'organic-search' }).map((s) => s.id)).toEqual(['A']);
      expect(applyFilters(sessions, { device: 'mobile' }).map((s) => s.id).sort()).toEqual(['A', 'C']);
      expect(applyFilters(sessions, { country: 'gb' }).map((s) => s.id)).toEqual(['B']); // case-insensitive
   });
});

describe('sessionConverted', () => {
   const session = sessionize([
      ev({ session: 'A', page: '/', type: 'pageview' }),
      ev({ session: 'A', page: '/demo/thanks', type: 'pageview' }),
      ev({ session: 'A', page: '/contact', type: 'form_submit' }),
   ])[0];

   it('page_reached matches by prefix or exact', () => {
      expect(sessionConverted(session, { kind: 'page_reached', matchValue: '/demo/thanks' })).toBe(true);
      expect(sessionConverted(session, { kind: 'page_reached', matchValue: '/demo', matchMode: 'prefix' })).toBe(true);
      expect(sessionConverted(session, { kind: 'page_reached', matchValue: '/demo', matchMode: 'exact' })).toBe(false);
      expect(sessionConverted(session, { kind: 'page_reached', matchValue: '/pricing' })).toBe(false);
   });
   it('event matches by type and optional page', () => {
      expect(sessionConverted(session, { kind: 'event', matchValue: 'form_submit' })).toBe(true);
      expect(sessionConverted(session, { kind: 'event', matchValue: 'form_submit', matchPage: '/contact' })).toBe(true);
      expect(sessionConverted(session, { kind: 'event', matchValue: 'form_submit', matchPage: '/pricing' })).toBe(false);
      expect(sessionConverted(session, { kind: 'event', matchValue: 'click' })).toBe(false);
   });
});
