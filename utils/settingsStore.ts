import { readFile, stat } from 'fs/promises';
import { ensureSynced } from '../database/database';
import Setting, { SINGLE_SETTING_ID } from '../database/models/setting';

// The single source of truth for the RAW stored settings blob (the encrypted JSON that used to live
// in data/settings.json). It is now ONE Postgres row (`setting`, id = 1), so there is no fragile
// shared file on the data volume. Three callers read/write through here so the file is gone for good:
//   - pages/api/settings.ts (getAppSettings / updateSettings)
//   - utils/searchConsole.ts (service-account credential fallback)
//   - utils/adwords.ts + pages/api/adwords.ts (Google Ads credentials)
//
// The blob shape and the cryptr encryption of sensitive fields are UNCHANGED from settings.json;
// only the storage moved. Callers still encrypt before writing and decrypt after reading, exactly
// as they did with the file. This module deliberately does NOT decrypt: it is the storage seam, not
// the crypto seam, so each caller keeps its own field-specific encryption.

// The legacy file. Read EXACTLY ONCE, on the first seed of the row, to preserve any existing
// UI-configured credentials. After the row exists, the file is never read again.
const LEGACY_SETTINGS_FILE = `${process.cwd()}/data/settings.json`;

// Read and parse the legacy data/settings.json if it exists, returning {} when it is missing or
// corrupt. This runs at most once per instance (only when the row does not yet exist), so a corrupt
// file degrades to defaults rather than crashing the one-time import.
const readLegacyFile = async (): Promise<Record<string, unknown>> => {
   const fileExists = await stat(LEGACY_SETTINGS_FILE).then(() => true).catch(() => false);
   if (!fileExists) { return {}; }
   try {
      const raw = await readFile(LEGACY_SETTINGS_FILE, { encoding: 'utf-8' });
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
   } catch (error) {
      console.error('[WARN] Could not import legacy data/settings.json during one-time seed:', error);
      return {};
   }
};

// Ensure the single global settings row exists, returning it. RACE-SAFE: findOrCreate is atomic on
// the PK (id = 1), so two concurrent first-reads cannot create two rows (the loser gets the winner's
// row). The defaults seed the blob from the legacy file ONCE, so an existing self-host's UI-entered
// credentials are preserved on first boot; after that the DB row is authoritative.
const ensureSettingRow = async (): Promise<Setting> => {
   await ensureSynced();
   // Probe first so we only touch the legacy file (one-time import) when the row is genuinely absent.
   const existing = await Setting.findByPk(SINGLE_SETTING_ID);
   if (existing) { return existing; }
   const legacy = await readLegacyFile();
   // where/defaults use the model ATTRIBUTE name (ID), which maps to the lowercase "id" column.
   const [row] = await Setting.findOrCreate({
      where: { ID: SINGLE_SETTING_ID },
      defaults: { ID: SINGLE_SETTING_ID, data: JSON.stringify(legacy) },
   });
   return row;
};

// Returns the RAW stored settings object (sensitive fields still encrypted). The blob is exactly what
// settings.json held. Never throws on a corrupt blob: it degrades to {} so callers see "no stored
// value" and fall back to env/defaults, identical to the old missing-file behavior.
export const getStoredSettings = async (): Promise<Record<string, any>> => {
   const row = await ensureSettingRow();
   try {
      const parsed = row.data ? JSON.parse(row.data) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
   } catch (error) {
      console.error('[WARN] Corrupt settings blob in the setting row, treating as empty.', error);
      return {};
   }
};

// Persists the RAW stored settings object (sensitive fields already encrypted by the caller) to the
// single global row. Ensures the row exists first (race-safe), then writes the blob. Throws on a real
// DB failure so the caller can return a 500 (the write did NOT happen), matching the old file-write
// failure path.
export const writeStoredSettings = async (settings: Record<string, any>): Promise<void> => {
   const row = await ensureSettingRow();
   await row.update({ data: JSON.stringify(settings) });
};
