import fs from 'fs';
import path from 'path';

/**
 * Guards a real bug class the route tests cannot catch: a new Sequelize model file that is never
 * registered in database/database.ts's `models` array. Route tests mock the models, so an
 * unregistered model passes every unit test and then throws ("model is not initialized") only on a
 * live database. The Goal model shipped that way once. This static check asserts every ACTIVE model
 * file is both imported AND present in the models array.
 *
 * TYPE-ONLY exception: account.ts and apiKey.ts remain on disk as pure TYPE dependencies for the
 * ~80 route files that still take `account: Account` params (single-user seam collapse), but they
 * are DELIBERATELY not registered as live tables (a single-user install has no account/api_key
 * table). They are exempted here so the guard does not force a dead SaaS table back onto the schema.
 */
describe('database model registration', () => {
   const dbSrc = fs.readFileSync(path.resolve(__dirname, '../../database/database.ts'), 'utf8');
   const modelDir = path.resolve(__dirname, '../../database/models');
   // Type-only model files kept on disk but intentionally NOT registered as live tables.
   const TYPE_ONLY = ['account.ts', 'apiKey.ts'];
   const modelFiles = fs.readdirSync(modelDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => !TYPE_ONLY.includes(f));
   const arrayMatch = dbSrc.match(/const models = \[([^\]]*)\]/);
   const modelsArray = arrayMatch ? arrayMatch[1] : '';

   it('imports and registers every active file in database/models/', () => {
      expect(arrayMatch).not.toBeNull();
      for (const file of modelFiles) {
         const base = file.replace('.ts', '');
         // Each active model file must be imported by path.
         expect(dbSrc).toContain(`./models/${base}`);
      }
      // Every imported model identifier must also appear in the models array.
      const importedNames = Array.from(dbSrc.matchAll(/import (\w+) from '\.\/models\//g)).map((m) => m[1]);
      expect(importedNames.length).toBe(modelFiles.length);
      for (const name of importedNames) {
         expect(modelsArray).toContain(name);
      }
   });
});
