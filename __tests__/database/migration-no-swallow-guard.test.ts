import fs from 'fs';
import path from 'path';

/**
 * Static guard against the swallow-and-mark-applied migration bug (the one CLAUDE.md and the launch
 * audit flag as the data-durability hazard).
 *
 * The bug: a migration up() that wraps its createTable/addColumn/addIndex/seed in
 * `} catch (error) { console.log('error :', error); }` swallows a REAL DDL failure, so up() resolves,
 * sequelize-cli records the migration as APPLIED in SequelizeMeta, exits 0, and entrypoint.sh's
 * fail-loud guard is DEFEATED. The instance then boots against a schema that is silently missing a
 * table or column (e.g. owner_id, the multi-tenant isolation column), and the migration is recorded
 * as done so it never re-runs. 20 legacy migrations had this; they were de-swallowed (up() now lets
 * real failures throw, idempotency comes only from the narrow describeTable probe). The correct
 * templates are 1750147200014 (createTable) and 1750147200019 (addColumn).
 *
 * This test fails if the swallow pattern `console.log('error :', error)` EVER reappears inside an
 * up() function. It is allowed ONLY inside down() (a best-effort down is fine: a failed down does not
 * brick a booting instance the way a falsely-applied up() does).
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const SWALLOW = "console.log('error :', error)";

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));

describe('migration durability: no up() swallows real errors', () => {
   it('finds migration files to check', () => {
      expect(migrationFiles.length).toBeGreaterThan(20);
   });

   migrationFiles.forEach((file) => {
      it(`${file}: every "${SWALLOW}" (if any) is inside down(), never up()`, () => {
         const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
         // The position where down() begins. Anything before it is up() (plus shared helpers, which
         // never contain the swallow). A swallow at an index before downStart is therefore in up().
         const downStart = src.search(/\bdown\s*:/);
         const lines = src.split('\n');
         let offset = 0;
         lines.forEach((line, idx) => {
            if (line.includes(SWALLOW)) {
               const inUp = downStart === -1 || offset < downStart;
               // eslint-disable-next-line jest/no-conditional-expect
               expect({ file, line: idx + 1, inUp, snippet: line.trim() }).toEqual(
                  expect.objectContaining({ inUp: false }),
               );
            }
            offset += line.length + 1;
         });
      });
   });
});
