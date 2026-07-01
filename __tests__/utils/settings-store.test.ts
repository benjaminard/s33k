/**
 * Tests for the DB-backed settings store (utils/settingsStore), which replaces data/settings.json.
 *
 * Invariants under test:
 *   1. ONE-TIME FILE IMPORT: when the `setting` row does not yet exist and a legacy data/settings.json
 *      is present, its contents seed the row exactly once. After the row exists, the file is NEVER read
 *      again (a later getStoredSettings reads the row, not the file).
 *   2. RACE-SAFE SEED: the row is created via mockFindOrCreate on the fixed id (1), so a concurrent first
 *      read cannot create two rows; the legacy file is only consulted when the probe finds no row.
 *   3. NO FILE WHEN ROW EXISTS: with the row already present, neither getStoredSettings nor
 *      writeStoredSettings touches the filesystem at all.
 *   4. WRITE ROUND-TRIP: writeStoredSettings persists the blob and getStoredSettings reads it back.
 *
 * fs/promises and the Setting model are mocked, so no real disk or DB is touched.
 */

const SINGLE_SETTING_ID = 1;

// A tiny in-memory stand-in for the single `setting` row.
type Row = { id: number, data: string, update: jest.Mock };
let storedRow: Row | null = null;

const makeRow = (data: string): Row => {
   const row: Row = {
      id: SINGLE_SETTING_ID,
      data,
      update: jest.fn(async (vals: { data: string }) => { row.data = vals.data; return row; }),
   };
   return row;
};

// The model mock's fns live inside the factory (jest hoists jest.mock above const decls, so a const
// ref in the factory's returned object would be in the TDZ at module load). The fns close over the
// module-level storedRow/makeRow, which are only EVALUATED when the fn is CALLED (after init). We grab
// the spies back off the mocked model below for assertions.
jest.mock('../../database/database', () => ({ __esModule: true, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/setting', () => ({
   __esModule: true,
   default: {
      findByPk: jest.fn(async () => storedRow),
      findOrCreate: jest.fn(async ({ defaults }: { defaults: { data: string } }) => {
         if (!storedRow) { storedRow = makeRow(defaults.data); }
         return [storedRow, true];
      }),
   },
   SINGLE_SETTING_ID: 1,
}));

// fs/promises: stat reports whether the legacy file "exists"; readFile returns its mock contents.
let legacyFileExists = false;
let legacyFileContents = '{}';
const readFileMock = jest.fn(async () => legacyFileContents);
const statMock = jest.fn(async () => {
   if (!legacyFileExists) { throw new Error('ENOENT'); }
   return {};
});
jest.mock('fs/promises', () => ({
   __esModule: true,
   readFile: (...args: unknown[]) => readFileMock(...args),
   stat: (...args: unknown[]) => statMock(...args),
}));

// eslint-disable-next-line import/first
import { getStoredSettings, writeStoredSettings } from '../../utils/settingsStore';
// eslint-disable-next-line import/first
import SettingModel from '../../database/models/setting';

const mockFindByPk = (SettingModel as unknown as { findByPk: jest.Mock }).findByPk;
const mockFindOrCreate = (SettingModel as unknown as { findOrCreate: jest.Mock }).findOrCreate;

beforeEach(() => {
   jest.clearAllMocks();
   storedRow = null;
   legacyFileExists = false;
   legacyFileContents = '{}';
});

describe('settingsStore one-time legacy file import', () => {
   it('seeds the row from data/settings.json when the row is absent and the file exists', async () => {
      legacyFileExists = true;
      legacyFileContents = JSON.stringify({ scaping_api: 'enc-key', scraper_type: 'serper' });

      const settings = await getStoredSettings();

      expect(settings.scaping_api).toBe('enc-key');
      expect(settings.scraper_type).toBe('serper');
      expect(readFileMock).toHaveBeenCalledTimes(1);
      expect(mockFindOrCreate).toHaveBeenCalledTimes(1);
   });

   it('NEVER reads the file again once the row exists (file read happens at most once)', async () => {
      legacyFileExists = true;
      legacyFileContents = JSON.stringify({ scaping_api: 'enc-key' });

      await getStoredSettings(); // seeds + reads file once
      readFileMock.mockClear();
      statMock.mockClear();

      // Second read: the row now exists, so mockFindByPk returns it and the file is untouched.
      const second = await getStoredSettings();
      expect(second.scaping_api).toBe('enc-key');
      expect(readFileMock).not.toHaveBeenCalled();
      expect(statMock).not.toHaveBeenCalled();
      expect(mockFindByPk).toHaveBeenCalled();
   });

   it('seeds an empty blob (not a crash) when the legacy file is absent', async () => {
      legacyFileExists = false;
      const settings = await getStoredSettings();
      expect(settings).toEqual({});
      expect(readFileMock).not.toHaveBeenCalled();
   });

   it('is race-safe: it creates the row via mockFindOrCreate on the fixed id, never an unguarded insert', async () => {
      legacyFileExists = false;
      await getStoredSettings();
      const callArg = mockFindOrCreate.mock.calls[0][0] as { where: { ID: number } };
      expect(callArg.where).toEqual({ ID: SINGLE_SETTING_ID });
   });

   it('degrades a corrupt legacy file to an empty seed rather than throwing', async () => {
      legacyFileExists = true;
      legacyFileContents = '{ this is : not json';
      const settings = await getStoredSettings();
      expect(settings).toEqual({});
   });
});

describe('settingsStore write round-trip', () => {
   it('persists the blob and reads it back, touching no file when the row exists', async () => {
      // Pre-create the row so no seed import happens.
      storedRow = makeRow('{}');

      await writeStoredSettings({ scaping_api: 'new-enc', smtp_password: 'enc-pw' });
      expect(storedRow.update).toHaveBeenCalledTimes(1);

      const readBack = await getStoredSettings();
      expect(readBack.scaping_api).toBe('new-enc');
      expect(readBack.smtp_password).toBe('enc-pw');
      // No file I/O on either call because the row already existed.
      expect(readFileMock).not.toHaveBeenCalled();
      expect(statMock).not.toHaveBeenCalled();
   });
});
