import { canonicalizeDomain } from '../../utils/canonical-domain';

/**
 * Unit tests for canonicalizeDomain, the one normalizer that keeps the per-domain authorization gate
 * and the per-domain DB lookup reasoning over the SAME string. The security-critical property is that
 * it is IDENTITY-PRESERVING: it must NOT slug-decode (never turn "a-b.com" into "a.b.com"), because
 * that decode is exactly what created the scoped-key domain-escape this util exists to close.
 */
describe('canonicalizeDomain', () => {
   it('lowercases, trims, and leaves a plain hostname otherwise unchanged', () => {
      expect(canonicalizeDomain('  Example.COM ')).toBe('example.com');
      expect(canonicalizeDomain('example.com')).toBe('example.com');
   });

   it('strips a leading protocol', () => {
      expect(canonicalizeDomain('https://example.com')).toBe('example.com');
      expect(canonicalizeDomain('http://example.com')).toBe('example.com');
   });

   it('strips a leading www. label', () => {
      expect(canonicalizeDomain('www.example.com')).toBe('example.com');
      expect(canonicalizeDomain('https://www.example.com')).toBe('example.com');
   });

   it('drops any path, query, or fragment', () => {
      expect(canonicalizeDomain('example.com/path/to/page')).toBe('example.com');
      expect(canonicalizeDomain('example.com/')).toBe('example.com');
      expect(canonicalizeDomain('https://www.example.com/a?b=c#d')).toBe('example.com');
   });

   it('strips a single trailing FQDN root dot', () => {
      expect(canonicalizeDomain('example.com.')).toBe('example.com');
   });

   it('is IDENTITY-PRESERVING: it never slug-decodes "-" into "." (the escape vector)', () => {
      // This is the whole point. A dashed domain stays dashed; it is NOT turned into "a.b.com".
      expect(canonicalizeDomain('a-b.com')).toBe('a-b.com');
      expect(canonicalizeDomain('my-site.co.uk')).toBe('my-site.co.uk');
      // Underscores are likewise preserved, not rewritten to dashes.
      expect(canonicalizeDomain('a_b.com')).toBe('a_b.com');
   });

   it('is IDEMPOTENT: running it twice equals running it once', () => {
      for (const raw of ['HTTPS://WWW.A-B.com/path/', ' example.com. ', 'www.foo.org', 'a-b.com']) {
         expect(canonicalizeDomain(canonicalizeDomain(raw))).toBe(canonicalizeDomain(raw));
      }
   });

   it('returns "" for a non-string input so callers can treat it as deny/not-found', () => {
      expect(canonicalizeDomain(undefined)).toBe('');
      expect(canonicalizeDomain(null)).toBe('');
      expect(canonicalizeDomain(['a.com', 'b.com'])).toBe('');
      expect(canonicalizeDomain(42)).toBe('');
   });
});
