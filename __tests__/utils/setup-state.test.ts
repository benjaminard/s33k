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
   computeSetupCompleted, computeSeoConfigured, publicBaseUrlHeaderFree, __resetSetupRuntimeState,
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
      expect(verifySetupToken(`${token.slice(0, -1)}0`)).toBe(false);
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
