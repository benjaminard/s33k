import fs from 'fs';
import path from 'path';

/**
 * Static guard against re-introducing the VARCHAR(255)-overflow prod bug.
 *
 * sequelize DataType.STRING is VARCHAR(255) on Postgres but unlimited TEXT on SQLite. So a STRING
 * column holding a URL / JSON / free-text value passes every (SQLite) test, then silently truncates
 * or rejects writes on prod Postgres. That class already broke rank tracking once (the widen-to-TEXT
 * migration was the fix). The widen list is hand-maintained, and the only other DB static test checks
 * PK-column case, not STRING-vs-TEXT, so nothing stops the next contributor from adding a risky STRING.
 *
 * This reads model files as TEXT (no imports, so it cannot trip the sequelize/uuid ESM issue) and
 * flags any DataType.STRING column whose name matches an unbounded-content heuristic and is not in an
 * explicit allowlist. It fails the build the moment a risky STRING is added, the same shape as the
 * knowledge-coverage and pk-column-parity gates.
 */
const MODELS_DIR = path.resolve(__dirname, '../../database/models');

// Substrings in a column name that imply genuinely unbounded content (a URL, JSON blob, path,
// free text, settings, history, tags, etc.). Such a column must be DataType.TEXT, never STRING.
const UNBOUNDED_HINTS = [
   'url', 'page', 'path', 'history', 'result', 'settings', 'tags', 'note', 'json', 'blob', 'content',
   'message', 'body', 'description', 'error', 'value', 'payload', 'referrer', 'query',
];

// Columns that match a hint but are genuinely bounded in practice and intentionally STRING. Keyed by
// "<modelFile>.<column>". Add here (with a reason) only when the value is provably short. Empty today
// because every genuinely unbounded field is already DataType.TEXT.
const ALLOWLIST = new Set<string>([]);

type StringColumn = { file: string, column: string };

// Parse every @Column({ ... DataType.STRING ... }) declaration and the attribute name that follows
// it, applying the field: override when present (that is the real DB column name).
const parseStringColumns = (file: string, src: string): StringColumn[] => {
   const out: StringColumn[] = [];
   const re = /@Column\(\{([^}]*?DataType\.STRING[^}]*?)\}\)\s*(\w+)/g;
   let m: RegExpExecArray | null = re.exec(src);
   while (m !== null) {
      const opts = m[1];
      const attr = m[2];
      const field = (opts.match(/field:\s*'([^']+)'/) || [])[1];
      out.push({ file, column: field || attr });
      m = re.exec(src);
   }
   return out;
};

describe('STRING-vs-TEXT guard (no unbounded content stored as VARCHAR(255))', () => {
   const modelFiles = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.ts'));
   const stringColumns = modelFiles.flatMap((f) => parseStringColumns(f, fs.readFileSync(path.join(MODELS_DIR, f), 'utf8')));

   it('found models and STRING columns to inspect (sanity guard, never passes vacuously)', () => {
      expect(modelFiles.length).toBeGreaterThan(0);
      expect(stringColumns.length).toBeGreaterThan(0);
   });

   it('no DataType.STRING column holds unbounded content (use DataType.TEXT instead)', () => {
      const offenders = stringColumns
         .filter(({ file, column }) => {
            const key = `${file}.${column}`;
            if (ALLOWLIST.has(key)) { return false; }
            const lower = column.toLowerCase();
            return UNBOUNDED_HINTS.some((hint) => lower.includes(hint));
         })
         .map(({ file, column }) => `${file}.${column}`);
      // Any offender means a column likely holding a URL/JSON/free-text value is VARCHAR(255) on
      // Postgres: switch it to DataType.TEXT, or add it to ALLOWLIST above with a reason if it is
      // provably short.
      expect(offenders).toEqual([]);
   });
});
