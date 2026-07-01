import { normalizeSegmentSpec, parseStoredSegmentFilters } from '../../utils/segmentFilters';

// normalizeSegmentSpec must keep only known SegmentFilters keys, apply the same channel aliasing and
// casing as the analytics routes, and survive both object and JSON-string inputs.
describe('normalizeSegmentSpec', () => {
   it('keeps only known keys and drops junk', () => {
      expect(normalizeSegmentSpec({ channel: 'ai', device: 'mobile', junk: 'x', nope: 1 })).toEqual({ channel: 'ai', device: 'mobile' });
   });

   it('aliases channel (aio -> ai, seo -> organic-search) and cases device/country', () => {
      expect(normalizeSegmentSpec({ channel: 'aio', device: 'MOBILE', country: 'us' })).toEqual({
         channel: 'ai', device: 'mobile', country: 'US',
      });
      expect(normalizeSegmentSpec({ channel: 'seo' })).toEqual({ channel: 'organic-search' });
   });

   it('coerces humanOnly from boolean and string', () => {
      expect(normalizeSegmentSpec({ channel: 'ai', humanOnly: true })).toEqual({ channel: 'ai', humanOnly: true });
      expect(normalizeSegmentSpec({ channel: 'ai', humanOnly: 'false' })).toEqual({ channel: 'ai', humanOnly: false });
      expect(normalizeSegmentSpec({ channel: 'ai', humanOnly: 'nonsense' })).toEqual({ channel: 'ai' });
   });

   it('accepts a JSON string and an empty/garbage input', () => {
      expect(normalizeSegmentSpec('{"channel":"referral","engagement":"engaged"}')).toEqual({ channel: 'referral', engagement: 'engaged' });
      expect(normalizeSegmentSpec('not json')).toEqual({});
      expect(normalizeSegmentSpec(undefined)).toEqual({});
      expect(normalizeSegmentSpec(['array'])).toEqual({});
   });
});

describe('parseStoredSegmentFilters', () => {
   it('round-trips a stored string through normalization', () => {
      expect(parseStoredSegmentFilters('{"channel":"ai","humanOnly":true,"landingPage":"/pricing"}')).toEqual({
         channel: 'ai', humanOnly: true, landingPage: '/pricing',
      });
   });

   it('returns {} for null/empty', () => {
      expect(parseStoredSegmentFilters(null)).toEqual({});
      expect(parseStoredSegmentFilters('')).toEqual({});
   });
});
