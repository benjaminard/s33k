import crypto from 'crypto';
import { getStoredSettings, writeStoredSettings } from './settingsStore';

/*
 * FIRST-RUN SETUP STATE: the seam behind the /setup installer page and POST /api/setup.
 *
 * s33k is headed to a fully headless, MCP-driven shape. The one browser moment the product keeps is
 * the first-run setup page: the operator boots the container, the log prints a one-time token URL,
 * they open /setup?token=..., optionally paste a Serper key, and get the MCP connect commands and
 * the beacon snippet. Everything after that happens from their own LLM. The design constraint that
 * governs this module: a secret (the Serper key) must never need to pass through an LLM chat, so
 * the setup path is browser-to-server only, and the token that gates it lives only in server
 * memory and the server log.
 *
 * WHY globalThis and not module-local state: the Next pages-router server build bundles each page
 * and API route as its own webpack entry. A shared module CAN be duplicated across those entries
 * (and dev hot-reload re-instantiates modules), so a module-local `let token` here could mint two
 * different tokens for /setup and /api/setup. State on globalThis is a true per-process singleton
 * regardless of how many bundles include this file. Same reason the well-known dev-singleton
 * patterns (e.g. caching a DB client) hang off globalThis.
 */

type SetupRuntimeState = {
   /** The one-time setup token. Minted on first use, held only in memory, regenerated each boot. */
   token: string | null,
   /** True once setup completed IN THIS PROCESS: the token is dead even before the DB re-read. */
   tokenConsumed: boolean,
   /** True once the boot log line has been printed for this process. */
   announced: boolean,
   /** Injected by database.ts: counts tracked domains. Injection (not an import) on purpose: a
    *  static model import here would drag sequelize ESM into every jest suite that touches this
    *  module, the exact regression class CLAUDE.md section B documents for allowedApiRoutes. */
   domainCounter: (() => Promise<number>) | null,
};

const stateKey = '__s33kSetupState';
const globalStore = globalThis as unknown as { [stateKey]?: SetupRuntimeState };

const getState = (): SetupRuntimeState => {
   if (!globalStore[stateKey]) {
      globalStore[stateKey] = {
         token: null, tokenConsumed: false, announced: false, domainCounter: null,
      };
   }
   return globalStore[stateKey] as SetupRuntimeState;
};

/**
 * Register the domain-count probe used by the usage half of the setup backfill rule. Called once
 * at module init by database/database.ts (which imports both this module and the Domain model);
 * injected rather than imported here to keep this module free of sequelize model dependencies.
 * @param {() => Promise<number>} counter - Resolves to the number of tracked domains.
 */
export const registerSetupDomainCounter = (counter: () => Promise<number>): void => {
   getState().domainCounter = counter;
};

/** Test-only: reset the per-process setup runtime state (token, consumed flag, announce guard). */
export const __resetSetupRuntimeState = (): void => { delete globalStore[stateKey]; };

/**
 * The public base URL of this instance, HEADER-FREE (never derived from request headers, per the
 * CLAUDE.md section D rule: a header-derived base can be poisoned and these URLs end up carrying
 * or receiving secrets). NEXT_PUBLIC_APP_URL when set; otherwise http://localhost:PORT. There is
 * no production throw here (unlike utils/baseUrl.ts) because entrypoint.sh already refuses to boot
 * a production instance without NEXT_PUBLIC_APP_URL, so the localhost fallback only ever serves
 * local dev, where it is the correct answer.
 * @returns {string} The base URL with no trailing slash.
 */
export const publicBaseUrlHeaderFree = (): string => {
   const configured = process.env.NEXT_PUBLIC_APP_URL;
   if (configured && configured.trim()) { return configured.trim().replace(/\/$/, ''); }
   const port = process.env.PORT || '3000';
   return `http://localhost:${port}`;
};

/**
 * Mint-once accessor for the one-time setup token: >= 32 bytes of entropy, hex-encoded, held only
 * in process memory. A restart mints a new one (and prints a new log line) until setup completes.
 * @returns {string} The current process's setup token.
 */
export const getSetupToken = (): string => {
   const state = getState();
   if (!state.token) { state.token = crypto.randomBytes(32).toString('hex'); }
   return state.token;
};

/**
 * Constant-time check of a presented setup token against the in-memory one. False when the token
 * was already consumed (setup completed this process), when nothing was presented, or on any
 * mismatch. Never leaks validity through timing.
 * @param {unknown} candidate - The presented token (query param or body field).
 * @returns {boolean} True only for the live, unconsumed token.
 */
export const verifySetupToken = (candidate: unknown): boolean => {
   const state = getState();
   if (state.tokenConsumed) { return false; }
   if (typeof candidate !== 'string' || candidate.length === 0) { return false; }
   const expected = getSetupToken();
   if (candidate.length !== expected.length) { return false; }
   return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
};

// The stored-settings fields whose presence marks an instance as ALREADY SET UP (the backfill
// rule). Any install that predates the setup_completed flag has no flag but does have real
// settings: a scraper key entered in the old UI, SMTP notification config, Search Console or
// Google Ads credentials. If any of these carries a value, the instance is in use and must NEVER
// see the first-run setup page.
const MEANINGFUL_SETTING_FIELDS = [
   'scaping_api',
   'smtp_password',
   'smtp_server',
   'notification_email',
   'search_console_client_email',
   'search_console_private_key',
   'adwords_client_id',
   'adwords_client_secret',
   'adwords_developer_token',
   'adwords_account_id',
];

/**
 * Pure backfill rule: does this RAW stored-settings blob mark the instance as already set up?
 * True when the durable setup_completed flag is set, when any credential-ish field carries a
 * value, or when a non-default scraper_type was chosen. A fresh install's blob is {} (or all
 * empty-string defaults), which correctly reads as NOT set up.
 * @param {Record<string, any>} stored - The raw stored settings blob (fields still encrypted).
 * @returns {boolean} True when the instance must be treated as setup-complete.
 */
export const computeSetupCompleted = (stored: Record<string, any>): boolean => {
   if (stored.setup_completed === true) { return true; }
   if (MEANINGFUL_SETTING_FIELDS.some((field) => typeof stored[field] === 'string' && stored[field].trim() !== '')) { return true; }
   if (typeof stored.scraper_type === 'string' && stored.scraper_type.trim() !== '' && stored.scraper_type !== 'none') { return true; }
   return false;
};

/**
 * Is first-run setup complete for this instance? Durable flag OR the backfill rule over the
 * stored blob OR an env-configured scraper (an instance whose Serper key/type comes from env,
 * like a docker-compose install, is configured and must never see the setup page).
 * @returns {Promise<boolean>} True when /setup and /api/setup must 404.
 */
export const isSetupCompleted = async (): Promise<boolean> => {
   const stored = await getStoredSettings();
   if (computeSetupCompleted(stored)) { return true; }
   // Env-configured scraper = an already-provisioned install (the settings row may be empty).
   if ((process.env.SERPER_API_KEY || process.env.SCAPING_API || '').trim() !== '') { return true; }
   if ((process.env.SCRAPER_TYPE || '').trim() !== '' && process.env.SCRAPER_TYPE !== 'none') { return true; }
   // Usage backfill: an install with ANY tracked domain is in use (the analytics-only case has no
   // credential in settings at all), so it must never resurface the installer after an upgrade.
   // Fail toward "not completed" on a read error: the routes are still token-gated and completing
   // setup is non-destructive, so the failure mode is a spurious log line, never data loss.
   const { domainCounter } = getState();
   if (domainCounter) {
      try {
         if ((await domainCounter()) > 0) { return true; }
      } catch (error) {
         // fall through to the settings-based answer
      }
   }
   return false;
};

/**
 * Mark setup complete: merge `extra` (already-encrypted fields, e.g. the Serper key) plus the
 * durable setup_completed flag into the stored blob, and kill the in-memory token permanently.
 * After this resolves, /setup and /api/setup 404 forever (flag in DB) and immediately (consumed
 * flag in memory, so even a racing request in this process is rejected).
 * @param {Record<string, any>} [extra] - Extra fields to merge into the stored settings blob.
 * @returns {Promise<void>}
 */
export const markSetupCompleted = async (extra?: Record<string, any>): Promise<void> => {
   const stored = await getStoredSettings();
   await writeStoredSettings({ ...stored, ...(extra || {}), setup_completed: true });
   const state = getState();
   state.tokenConsumed = true;
   state.token = null;
};

/**
 * SEO module configuration check, pure half. The SEO pillar is an OPTIONAL module: it is enabled
 * exactly when a SERP scraper is usable, i.e. a key exists (stored, still-encrypted presence is
 * enough, or env) AND a scraper type resolves to something other than 'none'. Mirrors the
 * resolution order of getAppSettings (pages/api/settings.ts): the stored value wins, env is the
 * fallback.
 * @param {Record<string, any>} stored - The raw stored settings blob.
 * @param {NodeJS.ProcessEnv} env - The process env (injectable for tests).
 * @returns {boolean} True when the SEO module is enabled.
 */
export const computeSeoConfigured = (stored: Record<string, any>, env: NodeJS.ProcessEnv): boolean => {
   const storedKey = typeof stored.scaping_api === 'string' ? stored.scaping_api.trim() : '';
   const key = storedKey || (env.SERPER_API_KEY || env.SCAPING_API || '').trim();
   if (!key) { return false; }
   const storedType = typeof stored.scraper_type === 'string' ? stored.scraper_type.trim() : '';
   const type = (storedType && storedType !== 'none') ? storedType : (env.SCRAPER_TYPE || '').trim();
   return Boolean(type) && type !== 'none';
};

/**
 * Is the SEO module enabled on this instance (a scraper key + type configured)?
 * @returns {Promise<boolean>}
 */
export const isSeoConfigured = async (): Promise<boolean> => {
   const stored = await getStoredSettings();
   return computeSeoConfigured(stored, process.env);
};

/**
 * Print the first-run setup log line, at most once per process, and only while setup is
 * incomplete. Called fire-and-forget from the boot hook (see database/database.ts ensureSynced).
 * Never throws: a failed settings read just skips the announce (the next boot retries).
 *
 * Skipped under jest (NODE_ENV=test): dozens of suites exercise ensureSynced with mocked DBs and
 * must not trigger a real settings read or noisy logs.
 * @returns {Promise<void>}
 */
export const announceSetupOnce = async (): Promise<void> => {
   const state = getState();
   if (state.announced || process.env.NODE_ENV === 'test') { return; }
   state.announced = true;
   try {
      if (await isSetupCompleted()) { return; }
      const url = `${publicBaseUrlHeaderFree()}/setup?token=${getSetupToken()}`;
      console.log(`[SETUP] Open ${url} to finish setup.`);
   } catch (error) {
      // Do not rethrow (this runs detached off the boot path) and allow a retry on the next call
      // site invocation by clearing the guard, so a transiently-down DB does not eat the announce.
      state.announced = false;
   }
};
