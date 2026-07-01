import type { NextApiRequest } from 'next';
import { resolveBaseUrl } from '../../utils/baseUrl';

// Build a minimal NextApiRequest-like object carrying only the headers resolveBaseUrl reads.
const reqWithHeaders = (headers: Record<string, string>): NextApiRequest => (
   { headers } as unknown as NextApiRequest
);

describe('resolveBaseUrl', () => {
   const ORIGINAL_ENV = { ...process.env };

   afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
   });

   it('prefers NEXT_PUBLIC_APP_URL and strips a trailing slash (header-independent)', () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://s33k.example.com/';
      // Even a forged X-Forwarded-Host is ignored when the explicit URL is set.
      const req = reqWithHeaders({ 'x-forwarded-host': 'attacker.evil.test' });
      expect(resolveBaseUrl(req)).toBe('https://s33k.example.com');
   });

   it('SECURITY: in production with NEXT_PUBLIC_APP_URL unset, refuses to build a link from a forged X-Forwarded-Host', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.NEXT_PUBLIC_APP_URL;
      const req = reqWithHeaders({
         'x-forwarded-host': 'attacker.evil.test',
         'x-forwarded-proto': 'https',
         host: 'attacker.evil.test',
      });
      // Fail-closed: it must THROW rather than return any value, and the forged host must never
      // surface. We assert both: the throw, and (via try/catch) that no attacker host leaks out.
      expect(() => resolveBaseUrl(req)).toThrow(/NEXT_PUBLIC_APP_URL is unset in production/);
      let leaked: string | undefined;
      try {
         leaked = resolveBaseUrl(req);
      } catch {
         leaked = undefined;
      }
      // Fail-closed contract: no value is returned at all, so the forged host cannot leak out.
      expect(leaked).toBeUndefined();
      expect(leaked ?? '').not.toContain('attacker.evil.test');
   });

   it('in production WITH NEXT_PUBLIC_APP_URL set, returns the configured URL and ignores forged headers', () => {
      process.env.NODE_ENV = 'production';
      process.env.NEXT_PUBLIC_APP_URL = 'https://real.s33k.io';
      const req = reqWithHeaders({ 'x-forwarded-host': 'attacker.evil.test', host: 'attacker.evil.test' });
      expect(resolveBaseUrl(req)).toBe('https://real.s33k.io');
   });

   it('in DEVELOPMENT, keeps the header / localhost fallback so local dev needs no config', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(resolveBaseUrl(reqWithHeaders({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
      // A forwarded host in dev is honored (dev convenience, not a prod path).
      expect(resolveBaseUrl(reqWithHeaders({ 'x-forwarded-host': 'dev.local', 'x-forwarded-proto': 'https' })))
         .toBe('https://dev.local');
   });

   it('in DEVELOPMENT with no host header at all, falls back to localhost without throwing', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(resolveBaseUrl(reqWithHeaders({}))).toBe('http://localhost:3000');
   });
});
