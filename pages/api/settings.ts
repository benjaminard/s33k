import type { NextApiRequest, NextApiResponse } from 'next';
import Cryptr from 'cryptr';
import getConfig from 'next/config';
import verifyUser from '../../utils/verifyUser';
import allScrapers from '../../scrapers/index';
import { getStoredSettings, writeStoredSettings } from '../../utils/settingsStore';
import { getFailedRetryKeywordIds } from '../../utils/scraper';

// GLOBAL INSTANCE SETTINGS, now POSTGRES-BACKED (not data/settings.json).
//
// WHY a single global row and not per-tenant: in the hosted model the OPERATOR runs the shared SERP
// scraper account, the SMTP sender, and the service-account / Google Ads integrations. These are
// INSTANCE config, changed only by the admin, never by a tenant, so they are stored as one global
// `setting` row (see database/models/setting.ts) and this route stays admin-only via verifyUser.
// Per-tenant notification settings would be a SEPARATE future design (a tenant-scoped table), not
// this row. The encrypted blob shape is byte-for-byte what settings.json held; only storage moved.

type SettingsGetResponse = {
   settings?: object | null,
   error?: string,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method === 'GET') {
      return getSettings(req, res);
   }
   if (req.method === 'PUT') {
      return updateSettings(req, res);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const getSettings = async (req: NextApiRequest, res: NextApiResponse<SettingsGetResponse>) => {
   const settings = await getAppSettings();
   if (settings) {
      const { publicRuntimeConfig } = getConfig();
      const version = publicRuntimeConfig?.version;
      return res.status(200).json({ settings: { ...settings, version } });
   }
   return res.status(400).json({ error: 'Error Loading Settings!' });
};

const updateSettings = async (req: NextApiRequest, res: NextApiResponse<SettingsGetResponse>) => {
   const { settings } = req.body || {};
   if (!settings) {
      // A13: missing request body is a client error, not a success.
      return res.status(400).json({ error: 'Settings Data not Provided!' });
   }
   try {
      const cryptr = new Cryptr(process.env.SECRET as string);
      const scaping_api = settings.scaping_api ? cryptr.encrypt(settings.scaping_api.trim()) : '';
      const smtp_password = settings.smtp_password ? cryptr.encrypt(settings.smtp_password.trim()) : '';
      const search_console_client_email = settings.search_console_client_email ? cryptr.encrypt(settings.search_console_client_email.trim()) : '';
      const search_console_private_key = settings.search_console_private_key ? cryptr.encrypt(settings.search_console_private_key.trim()) : '';
      const adwords_client_id = settings.adwords_client_id ? cryptr.encrypt(settings.adwords_client_id.trim()) : '';
      const adwords_client_secret = settings.adwords_client_secret ? cryptr.encrypt(settings.adwords_client_secret.trim()) : '';
      const adwords_developer_token = settings.adwords_developer_token ? cryptr.encrypt(settings.adwords_developer_token.trim()) : '';
      const adwords_account_id = settings.adwords_account_id ? cryptr.encrypt(settings.adwords_account_id.trim()) : '';

      const securedSettings = {
         ...settings,
         scaping_api,
         smtp_password,
         search_console_client_email,
         search_console_private_key,
         adwords_client_id,
         adwords_client_secret,
         adwords_developer_token,
         adwords_account_id,
      };

      // Persist the encrypted blob to the single global `setting` row (was data/settings.json). The
      // identical cryptr encryption above is preserved; only the storage target changed.
      await writeStoredSettings(securedSettings);
      return res.status(200).json({ settings });
   } catch (error) {
      console.log('[ERROR] Updating App Settings. ', error);
      // A13: encrypt or DB write threw, so settings were NOT saved. Server error, not 200.
      return res.status(500).json({ error: 'Error Updating Settings!' });
   }
};

export const getAppSettings = async () : Promise<SettingsType> => {
   const screenshotAPIKey = process.env.SCREENSHOT_API || '69408-serpbear';
   const defaultSettings: SettingsType = {
      scraper_type: 'none',
      notification_interval: 'never',
      notification_email: '',
      notification_email_from: '',
      notification_email_from_name: 's33k',
      smtp_server: '',
      smtp_port: '',
      smtp_username: '',
      smtp_password: '',
      scrape_retry: false,
      screenshot_key: screenshotAPIKey,
      search_console: true,
      search_console_client_email: '',
      search_console_private_key: '',
      keywordsColumns: ['Best', 'History', 'Volume', 'Search Console'],
      scrape_strategy: 'basic',
      scrape_pagination_limit: 5,
      scrape_smart_full_fallback: false,
   };

   // Settings now come from the single global `setting` Postgres row (was data/settings.json). The
   // store seeds the row from an existing settings.json once on first read, then is authoritative.
   const stored = await getStoredSettings();
   const settings: SettingsType = { ...defaultSettings, ...stored };
   // The failed-retry queue is DB-derived now (keywords with a real lastUpdateError), not a file.
   // Computed instance-wide here so the settings UI sees the same list it always did.
   const failedQueue: number[] = await getFailedRetryKeywordIds().catch(() => []);

   let decryptedSettings = settings;
   try {
      const cryptr = new Cryptr(process.env.SECRET as string);
      // Env fallback: a hosted instance can supply the SERP scraper key via env
      // (SERPER_API_KEY or SCAPING_API) so it never has to be entered in the UI.
      // The DB-stored value always wins, so existing UI-configured deployments are unchanged.
      const scaping_api = settings.scaping_api
         ? cryptr.decrypt(settings.scaping_api)
         : (process.env.SERPER_API_KEY || process.env.SCAPING_API || '');
      const smtp_password = settings.smtp_password ? cryptr.decrypt(settings.smtp_password) : '';
      const search_console_client_email = settings.search_console_client_email ? cryptr.decrypt(settings.search_console_client_email) : '';
      const search_console_private_key = settings.search_console_private_key ? cryptr.decrypt(settings.search_console_private_key) : '';
      const adwords_client_id = settings.adwords_client_id ? cryptr.decrypt(settings.adwords_client_id) : '';
      const adwords_client_secret = settings.adwords_client_secret ? cryptr.decrypt(settings.adwords_client_secret) : '';
      const adwords_developer_token = settings.adwords_developer_token ? cryptr.decrypt(settings.adwords_developer_token) : '';
      const adwords_account_id = settings.adwords_account_id ? cryptr.decrypt(settings.adwords_account_id) : '';

      decryptedSettings = {
         ...settings,
         // Env fallback for the scraper backend: a hosted instance can set
         // SCRAPER_TYPE (e.g. "serper") so scraping works without the UI step.
         // A DB-stored scraper_type (anything other than the default 'none') wins.
         scraper_type: (settings.scraper_type && settings.scraper_type !== 'none')
            ? settings.scraper_type
            : (process.env.SCRAPER_TYPE || settings.scraper_type),
         scaping_api,
         smtp_password,
         search_console_client_email,
         search_console_private_key,
         search_console_integrated: !!(process.env.SEARCH_CONSOLE_PRIVATE_KEY && process.env.SEARCH_CONSOLE_CLIENT_EMAIL)
         || !!(search_console_client_email && search_console_private_key),
         available_scrapers: allScrapers.map((scraper) => ({ label: scraper.name, value: scraper.id, allowsCity: !!scraper.allowsCity })),
         // The UI consumes failed_queue as string ids; keep that shape.
         failed_queue: failedQueue.map((id) => String(id)),
         screenshot_key: screenshotAPIKey,
         adwords_client_id,
         adwords_client_secret,
         adwords_developer_token,
         adwords_account_id,
         scrape_strategy: settings.scrape_strategy || 'basic',
         scrape_pagination_limit: settings.scrape_pagination_limit || 5,
         scrape_smart_full_fallback: settings.scrape_smart_full_fallback || false,
      };
   } catch (error) {
      console.log('Error Decrypting Settings API Keys!');
   }

   return decryptedSettings;
};
