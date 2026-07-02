/**
 * utils/setupState: the first-run installer seam.
 *
 * Covers the parts the /setup page and POST /api/setup lean on:
 *   - the one-time boot token: mint-once, constant-time verify, dead forever after completion;
 *   - the BACKFILL rule: an existing install (settings present, no setup_completed flag) must be
 *     treated as ALREADY COMPLETED so it never sees the setup page, while a truly fresh install
 *     (empty blob) is not;
 *   - env-configured installs (Serper key/type via env) also count as completed;
 *   - the SEO-module configuration check (computeSeoConfigured), the gate behind modular status;
 *   - the boot announce: prints exactly one [SETUP] line, only while setup is incomplete.
 *
 * The settings store is mocked (this suite tests the seam, not the row), per the repo convention
 * of mocking the IO boundary and testing pure logic directly.
 */
jest.mock('../../utils/settingsStore', () => ({
   __esModule: true,
   getStoredSettings: jest.fn(async () => ({})),
   writeStoredSettings: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import {
   getSetupToken, verifySetupToken, markSetupCompleted, isSetupCompleted, announceSetupOnce,
   computeSetupCompleted, computeSeoConfigured, computeGscConfigured, publicBaseUrlHeaderFree, __resetSetupRuntimeState,
   registerSetupDomainCounter,
} from '../../utils/setupState';
// eslint-disable-next-line import/first
import { getStoredSettings, writeStoredSettings } from '../../utils/settingsStore';

const mockRead = getStoredSettings as unknown as jest.Mock;
const mockWrite = writeStoredSettings as unknown as jest.Mock;

const ENV_KEYS = ['SERPER_API_KEY', 'SCAPING_API', 'SCRAPER_TYPE', 'NEXT_PUBLIC_APP_URL', 'PORT'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
   jest.clearAllMocks();
   __resetSetupRuntimeState();
   mockRead.mockResolvedValue({});
   ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
});

afterEach(() => {
   ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) { delete process.env[k]; } else { process.env[k] = savedEnv[k]; }
   });
});

describe('setup token', () => {
   it('mints once per process, with at least 64 hex chars of entropy', () => {
      const token = getSetupToken();
      expect(token).toMatch(/^[0-9a-f]{64,}$/);
      expect(getSetupToken()).toBe(token);
   });

   it('verifies only the exact live token', () => {
      const token = getSetupToken();
      expect(verifySetupToken(token)).toBe(true);
      // Tamper DETERMINISTICALLY: replacing the last char with a literal '0' was a 1-in-16 flake
      // (a random hex token already ending in '0' made the "tampered" value equal the real one).
      // Same guard the key-drop suite uses.
      expect(verifySetupToken(`${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).toBe(false);
      expect(verifySetupToken('')).toBe(false);
      expect(verifySetupToken(undefined)).toBe(false);
      expect(verifySetupToken(token.slice(0, 10))).toBe(false);
   });

   it('is dead forever after markSetupCompleted, even for the previously-valid value', async () => {
      const token = getSetupToken();
      await markSetupCompleted();
      expect(verifySetupToken(token)).toBe(false);
      // Even a freshly minted token cannot verify: setup completed in this process.
      expect(verifySetupToken(getSetupToken())).toBe(false);
   });

   it('markSetupCompleted merges extra fields plus the durable flag into the stored blob', async () => {
      mockRead.mockResolvedValue({ existing_field: 'keep-me' });
      await markSetupCompleted({ scaping_api: 'encrypted-key', scraper_type: 'serper' });
      expect(mockWrite).toHaveBeenCalledWith({
         existing_field: 'keep-me',
         scaping_api: 'encrypted-key',
         scraper_type: 'serper',
         setup_completed: true,
      });
   });
});

describe('computeSetupCompleted (the backfill rule, pure)', () => {
   it('a truly fresh install (empty blob) is NOT completed', () => {
      expect(computeSetupCompleted({})).toBe(false);
   });

   it('all-empty-string defaults (a saved-but-blank settings form) is NOT completed', () => {
      expect(computeSetupCompleted({
         scaping_api: '', smtp_password: '', scraper_type: 'none', notification_email: '',
      })).toBe(false);
   });

   it('the durable flag completes', () => {
      expect(computeSetupCompleted({ setup_completed: true })).toBe(true);
   });

   it('BACKFILL: an existing install with a stored scraper key but NO flag is completed', () => {
      expect(computeSetupCompleted({ scaping_api: 'encrypted-blob' })).toBe(true);
   });

   it('BACKFILL: a chosen scraper type (not the "none" default) is completed', () => {
      expect(computeSetupCompleted({ scraper_type: 'serper' })).toBe(true);
   });

   it('BACKFILL: any credential-ish field (smtp, search console, adwords) is completed', () => {
      expect(computeSetupCompleted({ smtp_server: 'smtp.example.com' })).toBe(true);
      expect(computeSetupCompleted({ search_console_private_key: 'enc' })).toBe(true);
      expect(computeSetupCompleted({ adwords_client_id: 'enc' })).toBe(true);
   });
});

describe('isSetupCompleted (flag OR backfill OR env-configured)', () => {
   it('fresh blob + no env = not completed', async () => {
      await expect(isSetupCompleted()).resolves.toBe(false);
   });

   it('an env-configured Serper key counts as completed (docker-compose installs)', async () => {
      process.env.SERPER_API_KEY = 'env-key';
      await expect(isSetupCompleted()).resolves.toBe(true);
   });

   it('an env-configured scraper type counts as completed', async () => {
      process.env.SCRAPER_TYPE = 'serper';
      await expect(isSetupCompleted()).resolves.toBe(true);
   });

   it('stored settings win without any env (the Ben-production shape)', async () => {
      mockRead.mockResolvedValue({ scaping_api: 'encrypted-blob', scraper_type: 'serper' });
      await expect(isSetupCompleted()).resolves.toBe(true);
   });

   it('an existing tracked domain counts as completed (the analytics-only install shape)', async () => {
      // No credential in settings, no env: only usage. The installer must never resurface on an
      // in-use analytics-only install after an upgrade.
      registerSetupDomainCounter(async () => 1);
      await expect(isSetupCompleted()).resolves.toBe(true);
   });

   it('a failing domain counter falls back to the settings-based answer', async () => {
      registerSetupDomainCounter(async () => { throw new Error('db down'); });
      await expect(isSetupCompleted()).resolves.toBe(false);
   });

   it('a zero domain count does not complete a truly fresh install', async () => {
      registerSetupDomainCounter(async () => 0);
      await expect(isSetupCompleted()).resolves.toBe(false);
   });
});

describe('computeSeoConfigured (the SEO-module gate, pure)', () => {
   it('off with no key anywhere', () => {
      expect(computeSeoConfigured({}, {} as NodeJS.ProcessEnv)).toBe(false);
   });

   it('on with a stored key + stored type', () => {
      expect(computeSeoConfigured({ scaping_api: 'enc', scraper_type: 'serper' }, {} as NodeJS.ProcessEnv)).toBe(true);
   });

   it('on with env key + env type (no stored settings)', () => {
      expect(computeSeoConfigured({}, { SERPER_API_KEY: 'k', SCRAPER_TYPE: 'serper' } as unknown as NodeJS.ProcessEnv)).toBe(true);
   });

   it('off with a key but no resolvable scraper type', () => {
      expect(computeSeoConfigured({ scaping_api: 'enc', scraper_type: 'none' }, {} as NodeJS.ProcessEnv)).toBe(false);
   });

   it('off with a type but no key', () => {
      expect(computeSeoConfigured({ scraper_type: 'serper' }, {} as NodeJS.ProcessEnv)).toBe(false);
   });
});

describe('computeGscConfigured (the Search Console module gate, pure)', () => {
   it('not connected with no credential anywhere', () => {
      expect(computeGscConfigured({}, {} as NodeJS.ProcessEnv)).toBe(false);
      expect(computeGscConfigured({}, {} as NodeJS.ProcessEnv, null)).toBe(false);
   });

   it('connected via the stored settings service-account pair (the key-drop fields)', () => {
      expect(computeGscConfigured(
         { search_console_client_email: 'enc-email', search_console_private_key: 'enc-key' },
         {} as NodeJS.ProcessEnv,
      )).toBe(true);
   });

   it('NOT connected when only one settings field is set', () => {
      expect(computeGscConfigured({ search_console_client_email: 'enc-email' }, {} as NodeJS.ProcessEnv)).toBe(false);
      expect(computeGscConfigured({ search_console_private_key: 'enc-key' }, {} as NodeJS.ProcessEnv)).toBe(false);
   });

   it('connected via the env service-account pair', () => {
      const env = { SEARCH_CONSOLE_CLIENT_EMAIL: 'sa@x.iam.gserviceaccount.com', SEARCH_CONSOLE_PRIVATE_KEY: 'pem' };
      expect(computeGscConfigured({}, env as unknown as NodeJS.ProcessEnv)).toBe(true);
   });

   it('connected via a per-domain OAuth refresh token ONLY when the OAuth env pair exists', () => {
      const blob = JSON.stringify({ property_type: 'domain', oauth_refresh_token: 'enc-token' });
      const oauthEnv = { GSC_OAUTH_CLIENT_ID: 'id', GSC_OAUTH_CLIENT_SECRET: 'sec' } as unknown as NodeJS.ProcessEnv;
      expect(computeGscConfigured({}, oauthEnv, blob)).toBe(true);
      // A refresh token without the OAuth app config cannot be used by the read path.
      expect(computeGscConfigured({}, {} as NodeJS.ProcessEnv, blob)).toBe(false);
   });

   it('connected via a per-domain service-account pair in the blob (no OAuth env needed)', () => {
      const blob = JSON.stringify({ client_email: 'enc-email', private_key: 'enc-key' });
      expect(computeGscConfigured({}, {} as NodeJS.ProcessEnv, blob)).toBe(true);
   });

   it('a malformed blob falls back to the settings+env answer instead of throwing', () => {
      expect(computeGscConfigured({}, {} as NodeJS.ProcessEnv, '{not json')).toBe(false);
      expect(computeGscConfigured(
         { search_console_client_email: 'enc-email', search_console_private_key: 'enc-key' },
         {} as NodeJS.ProcessEnv,
         '{not json',
      )).toBe(true);
   });
});

describe('publicBaseUrlHeaderFree', () => {
   it('prefers NEXT_PUBLIC_APP_URL, trailing slash stripped', () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://s33k.example.com/';
      expect(publicBaseUrlHeaderFree()).toBe('https://s33k.example.com');
   });

   it('falls back to http://localhost:PORT, never request headers', () => {
      process.env.PORT = '4321';
      expect(publicBaseUrlHeaderFree()).toBe('http://localhost:4321');
   });
});

describe('announceSetupOnce (the boot log line)', () => {
   // jest runs with NODE_ENV=test, where the announce is a deliberate no-op (so the dozens of
   // suites that touch ensureSynced stay silent). Temporarily lift that to test the real path.
   const withDevEnv = async (fn: () => Promise<void>) => {
      const prior = process.env.NODE_ENV;
      (process.env as Record<string, string>).NODE_ENV = 'development';
      try { await fn(); } finally { (process.env as Record<string, string>).NODE_ENV = prior as string; }
   };

   it('prints the [SETUP] token URL exactly once while setup is incomplete', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await withDevEnv(async () => {
         await announceSetupOnce();
         await announceSetupOnce();
      });
      const setupLines = spy.mock.calls.filter((c) => String(c[0]).startsWith('[SETUP]'));
      expect(setupLines).toHaveLength(1);
      expect(String(setupLines[0][0])).toContain(`/setup?token=${getSetupToken()}`);
      spy.mockRestore();
   });

   it('prints nothing when setup is already completed (backfill or flag)', async () => {
      mockRead.mockResolvedValue({ setup_completed: true });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await withDevEnv(async () => { await announceSetupOnce(); });
      expect(spy.mock.calls.filter((c) => String(c[0]).startsWith('[SETUP]'))).toHaveLength(0);
      spy.mockRestore();
   });

   it('is a no-op under NODE_ENV=test (keeps every other suite silent)', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await announceSetupOnce();
      expect(spy.mock.calls.filter((c) => String(c[0]).startsWith('[SETUP]'))).toHaveLength(0);
      spy.mockRestore();
   });
});
