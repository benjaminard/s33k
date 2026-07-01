/**
 * Tests for the SERP scraper-key (and scraper_type) env fallback in
 * getAppSettings (pages/api/settings.ts).
 *
 * The deploy reality this guards: a fresh container starts with an empty
 * settings DB and no scraper key entered in the UI. A hosted instance must be
 * able to supply the SERP key (and the scraper backend) purely via env so
 * onboarding does not require the UI step. The contract under test:
 *
 *   1. When the DB-stored scaping_api is empty, the env value is used
 *      (SERPER_API_KEY first, then SCAPING_API). Likewise scraper_type falls
 *      back to SCRAPER_TYPE when the stored value is the default 'none'.
 *   2. When the DB has a stored scaping_api / scraper_type, the DB value WINS
 *      and the env is ignored, so existing UI-configured deployments are
 *      byte-for-byte unchanged.
 *   3. With neither DB nor env set, the key resolves to '' (empty), not
 *      undefined, so downstream code is unchanged.
 *
 * The DB-backed settings store (utils/settingsStore) is mocked so no real DB is touched, and Cryptr
 * is mocked so encrypt/decrypt are identity transforms (no real SECRET needed).
 * No network.
 */

// Settings now come from the DB-backed store (utils/settingsStore), not data/settings.json. Mock the
// store so getStoredSettings returns whatever stored (encrypted) settings the current test sets, and
// mock the scraper's DB-backed failed-queue helper (it imports cheerio, which jest cannot parse).
let mockStoredSettings: Record<string, unknown> = {};
jest.mock('../../utils/settingsStore', () => ({
   __esModule: true,
   getStoredSettings: jest.fn(async () => mockStoredSettings),
   writeStoredSettings: jest.fn(async () => undefined),
}));
jest.mock('../../utils/scraper', () => ({
   __esModule: true,
   getFailedRetryKeywordIds: jest.fn(async () => []),
}));

// Cryptr: identity transform so decrypt(stored) === stored without a real SECRET.
jest.mock('cryptr', () => {
   return jest.fn().mockImplementation(() => ({
      encrypt: (v: string) => v,
      decrypt: (v: string) => v,
   }));
});

// next/config: getAppSettings does not read it, but settings.ts imports it.
jest.mock('next/config', () => ({ __esModule: true, default: () => ({ publicRuntimeConfig: { version: 'test' } }) }));

// scrapers/index: keep the available_scrapers mapping cheap and deterministic.
jest.mock('../../scrapers/index', () => ({ __esModule: true, default: [{ id: 'serper', name: 'Serper', allowsCity: false }] }));

// eslint-disable-next-line import/first
import { getAppSettings } from '../../pages/api/settings';

const ORIGINAL_ENV = { ...process.env };

/** Set the stored (encrypted) settings the mocked getStoredSettings returns. */
const setStoredSettings = (obj: Record<string, unknown>) => { mockStoredSettings = obj; };

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = 'unit-test-secret';
   delete process.env.SERPER_API_KEY;
   delete process.env.SCAPING_API;
   delete process.env.SCRAPER_TYPE;
   setStoredSettings({});
});

afterEach(() => {
   process.env = { ...ORIGINAL_ENV };
});

describe('getAppSettings SERP-key env fallback', () => {
   it('uses SERPER_API_KEY env when the DB-stored scaping_api is empty', async () => {
      process.env.SERPER_API_KEY = 'env-serper-key';
      setStoredSettings({ scaping_api: '' });

      const settings = await getAppSettings();
      expect(settings.scaping_api).toBe('env-serper-key');
   });

   it('falls back to SCAPING_API env when SERPER_API_KEY is not set', async () => {
      process.env.SCAPING_API = 'env-scaping-key';
      setStoredSettings({ scaping_api: '' });

      const settings = await getAppSettings();
      expect(settings.scaping_api).toBe('env-scaping-key');
   });

   it('prefers SERPER_API_KEY over SCAPING_API when both env vars are set', async () => {
      process.env.SERPER_API_KEY = 'serper-wins';
      process.env.SCAPING_API = 'scaping-loses';
      setStoredSettings({ scaping_api: '' });

      const settings = await getAppSettings();
      expect(settings.scaping_api).toBe('serper-wins');
   });

   it('lets the DB-stored scaping_api WIN over the env value (existing UI deployments unchanged)', async () => {
      process.env.SERPER_API_KEY = 'env-key-should-be-ignored';
      // Cryptr is mocked as identity, so the stored (encrypted) value reads back verbatim.
      setStoredSettings({ scaping_api: 'db-stored-key' });

      const settings = await getAppSettings();
      expect(settings.scaping_api).toBe('db-stored-key');
   });

   it('resolves to an empty string (not undefined) when neither DB nor env supplies a key', async () => {
      setStoredSettings({ scaping_api: '' });

      const settings = await getAppSettings();
      expect(settings.scaping_api).toBe('');
   });

   it('falls back scraper_type to SCRAPER_TYPE env when the stored value is the default none', async () => {
      process.env.SCRAPER_TYPE = 'serper';
      setStoredSettings({ scraper_type: 'none' });

      const settings = await getAppSettings();
      expect(settings.scraper_type).toBe('serper');
   });

   it('lets a stored non-default scraper_type WIN over the SCRAPER_TYPE env', async () => {
      process.env.SCRAPER_TYPE = 'serper';
      setStoredSettings({ scraper_type: 'serpapi' });

      const settings = await getAppSettings();
      expect(settings.scraper_type).toBe('serpapi');
   });
});
