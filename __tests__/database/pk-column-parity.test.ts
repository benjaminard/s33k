import fs from 'fs';
import path from 'path';

/**
 * Static guard for the exact bug that cost prod redeploys tonight: a model's primary-key column
 * name disagreeing in CASE with the column its create-table migration declares (the goal model
 * mapped field: 'id' while the migration created "ID"; SQLite hid it, Postgres rejected it).
 *
 * This reads model and migration files as TEXT (no imports, so it cannot trip the sequelize/uuid
 * ESM issue that forces the route tests to mock models) and asserts: for every table created by a
 * createTable migration, the model's PK column name matches the migration's PK column key exactly.
 */
const MODELS_DIR = path.resolve(__dirname, '../../database/models');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');

// Model -> { tableName, pkColumn }. pkColumn is the @PrimaryKey @Column's field: override, else
// the attribute name.
const parseModel = (src: string): { tableName: string | null, pkColumn: string | null } => {
   const tableName = (src.match(/tableName:\s*'([^']+)'/) || [])[1] || null;
   const pkMatch = src.match(/@PrimaryKey\s*@Column\(\{([\s\S]*?)\}\)\s*(\w+)\s*!?\s*:/);
   if (!pkMatch) { return { tableName, pkColumn: null }; }
   const columnOpts = pkMatch[1];
   const attr = pkMatch[2];
   const field = (columnOpts.match(/field:\s*'([^']+)'/) || [])[1];
   return { tableName, pkColumn: field || attr };
};

// Migration -> { tableName, pkColumn } for createTable migrations (else nulls).
const parseMigration = (src: string): { tableName: string | null, pkColumn: string | null } => {
   const ct = src.match(/createTable\(\s*'([^']+)'\s*,\s*\{/);
   if (!ct) { return { tableName: null, pkColumn: null }; }
   const tableName = ct[1];
   // The PK column is the column key whose definition contains primaryKey: true.
   const pk = src.match(/(\w+):\s*\{[^{}]*primaryKey:\s*true[^{}]*\}/);
   return { tableName, pkColumn: pk ? pk[1] : null };
};

describe('primary-key column parity (model <-> create-table migration)', () => {
   const migrations = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))
      .map((f) => parseMigration(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
      .filter((m) => m.tableName && m.pkColumn);

   const models = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.ts'))
      .map((f) => parseModel(fs.readFileSync(path.join(MODELS_DIR, f), 'utf8')))
      .filter((m) => m.tableName && m.pkColumn);

   it('found create-table migrations and models to compare', () => {
      expect(migrations.length).toBeGreaterThan(0);
      expect(models.length).toBeGreaterThan(0);
   });

   it('every created table\'s model PK column matches the migration PK column (case-exact)', () => {
      for (const mig of migrations) {
         const model = models.find((m) => m.tableName === mig.tableName);
         if (!model) { continue; } // table may be defined model-side only; skip rather than flake
         expect(`${mig.tableName}.${model.pkColumn}`).toBe(`${mig.tableName}.${mig.pkColumn}`);
      }
   });
});
