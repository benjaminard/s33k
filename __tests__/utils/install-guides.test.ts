/**
 * Tests for the install-guide library (utils/install-guides.ts).
 *
 * getInstallGuides turns a domain into the exact s33k.js beacon snippet and per-platform,
 * copy-paste install instructions. It is pure product knowledge: no network, no LLM, no secrets.
 * The first-party beacon keys every event by domain, so the snippet emits data-domain (what
 * public/s33k.js reads to identify the site), not the retired data-website-id. These tests assert:
 *   - the snippet embeds the resolved script URL and the domain as data-domain,
 *   - the script URL resolves from S33K_SCRIPT_URL when set, otherwise derives from
 *     S33K_BEACON_HOST as `${base}/s33k.js`, otherwise falls back to a bare "/s33k.js",
 *   - the platform set covers the documented surfaces and a couple of them carry accurate steps.
 *
 * install-guides is dependency-free (it inlines its own base-URL normalizer); only env vars are
 * manipulated here.
 */

import { getInstallGuides } from '../../utils/install-guides';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('getInstallGuides snippet + script URL resolution', () => {
   it('derives the script URL from S33K_BEACON_HOST and embeds it with the website id', () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.S33K_SCRIPT_URL;
      process.env.S33K_BEACON_HOST = 'https://analytics.example.com/';

      const guides = getInstallGuides('getmasset.com', 'web-123');
      expect(guides.scriptUrl).toBe('https://analytics.example.com/s33k.js');
      expect(guides.websiteId).toBe('web-123');
      expect(guides.snippet).toBe('<script defer src="https://analytics.example.com/s33k.js" data-domain="web-123"></script>');
   });

   it('prefers an explicit S33K_SCRIPT_URL over the derived base URL', () => {
      process.env = { ...ORIGINAL_ENV };
      process.env.S33K_BEACON_HOST = 'https://analytics.example.com';
      process.env.S33K_SCRIPT_URL = 'https://cdn.example.com/u.js';

      const guides = getInstallGuides('example.com', 'abc');
      expect(guides.scriptUrl).toBe('https://cdn.example.com/u.js');
      expect(guides.snippet).toContain('src="https://cdn.example.com/u.js"');
   });

   it('falls back to a bare /s33k.js when no host or explicit script URL is configured', () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.S33K_SCRIPT_URL;
      delete process.env.S33K_BEACON_HOST;

      const guides = getInstallGuides('example.com', 'abc');
      expect(guides.scriptUrl).toBe('/s33k.js');
   });

   it('trims a whitespace-only site id down to an empty data-domain so the shape is still returned', () => {
      process.env = { ...ORIGINAL_ENV };
      process.env.S33K_BEACON_HOST = 'https://analytics.example.com';

      const guides = getInstallGuides('example.com', '   ');
      expect(guides.websiteId).toBe('');
      expect(guides.snippet).toContain('data-domain=""');
   });
});

describe('getInstallGuides platform coverage and steps', () => {
   beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      process.env.S33K_BEACON_HOST = 'https://analytics.example.com';
   });

   it('includes every supported platform', () => {
      const guides = getInstallGuides('example.com', 'web-1');
      const names = guides.platforms.map((p) => p.platform);
      expect(names).toEqual(expect.arrayContaining([
         'Raw HTML',
         'Google Tag Manager',
         'WordPress',
         'Webflow',
         'Shopify',
         'Squarespace',
         'Wix',
         'Next.js / React',
      ]));
      // Every platform carries at least one concrete step.
      guides.platforms.forEach((p) => expect(p.steps.length).toBeGreaterThan(0));
   });

   it('gives accurate, specific steps for Google Tag Manager', () => {
      const guides = getInstallGuides('example.com', 'web-1');
      const gtm = guides.platforms.find((p) => p.platform === 'Google Tag Manager');
      expect(gtm).toBeDefined();
      const joined = gtm!.steps.join(' ');
      expect(joined).toMatch(/Custom HTML/i);
      expect(joined).toMatch(/All Pages/i);
      expect(joined).toMatch(/Submit and Publish/i);
   });

   it('gives Shopify steps that point at theme.liquid and the closing head tag', () => {
      const guides = getInstallGuides('example.com', 'web-1');
      const shopify = guides.platforms.find((p) => p.platform === 'Shopify');
      const joined = shopify!.steps.join(' ');
      expect(joined).toMatch(/theme\.liquid/);
      expect(joined).toMatch(/<\/head>/);
   });

   it('embeds the resolved script URL and website id into the Next.js / React Script example', () => {
      const guides = getInstallGuides('example.com', 'web-xyz');
      const next = guides.platforms.find((p) => p.platform === 'Next.js / React');
      const joined = next!.steps.join('\n');
      expect(joined).toContain('next/script');
      expect(joined).toContain('https://analytics.example.com/s33k.js');
      expect(joined).toContain('data-domain="web-xyz"');
   });

   it('never leaks the internal provider name into any platform step (user-facing copy is s33k-branded)', () => {
      const guides = getInstallGuides('example.com', 'web-1');
      guides.platforms.forEach((p) => {
         p.steps.forEach((step) => expect(step).not.toMatch(/Umami/i));
      });
   });

   it('labels the example tag name as "s33k Analytics" in the GTM and Wix guides', () => {
      const guides = getInstallGuides('example.com', 'web-1');
      const gtm = guides.platforms.find((p) => p.platform === 'Google Tag Manager');
      const wix = guides.platforms.find((p) => p.platform === 'Wix');
      expect(gtm!.steps.join(' ')).toContain('s33k Analytics');
      expect(wix!.steps.join(' ')).toContain('s33k Analytics');
   });
});
