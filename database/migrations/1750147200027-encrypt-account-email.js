// Migration: Encrypt account.email at rest + add the email_hash blind index.
//
// WHY: account.email is the magic-link login key and PII. It was stored PLAINTEXT, so a DB dump
// exposed every tenant's login email. This migration moves it to encryption at rest:
//   - account.email      -> the cryptr (AES-256, keyed by SECRET) CIPHERTEXT of the address (was
//                           plaintext). Non-deterministic (random IV), so not usable for lookup.
//   - account.email_hash -> a NEW column, the deterministic keyed HMAC-SHA256(SECRET, normalized
//                           email) blind index, hex. This becomes the LOOKUP key and the column the
//                           UNIQUE index sits on (dedupe one account per email). Many NULLs allowed.
//
// It therefore: (1) adds email_hash, (2) DROPS the old UNIQUE index on the plaintext email column
// (the ciphertext is non-deterministic, so uniqueness must move to the hash), (3) BACKFILLS every
// existing non-null email row's email_hash from its current PLAINTEXT email and RE-ENCRYPTS the email
// in place, (4) adds the UNIQUE index on email_hash. The backfill MUST happen before adding the unique
// index, or two rows that happen to share an email would both compute the same hash and the index
// would fail to create. It runs inside one transaction so a failure leaves the table consistent.
//
// SECRET dependency: the encrypt + hash use process.env.SECRET (the same env var cryptr uses for
// connected credentials). entrypoint.sh runs migrations on boot with the full prod env, so SECRET is
// present. If SECRET is somehow unset, we DO NOT silently store plaintext or skip the unique index
// (that would re-create the exact PII-at-rest hole); we THROW so the fail-loud boot refuses to start
// against a broken/insecure state, exactly the class of failure CLAUDE.md A says must never be
// swallowed. (With MULTI_TENANT off there are no account emails, so the backfill loop is a no-op, but
// the column + index are still created additively so flipping the flag later needs no further migration.)
//
// FAIL-LOUD + IDEMPOTENT: we guard ONLY idempotency (column/index already present, a row already
// looking encrypted) and let any REAL failure throw. Re-running is a clean no-op. Dual-convention
// (Umzug v3 { context } and classic positional).

const crypto = require('crypto');
const { DataTypes } = require('sequelize');
const Cryptr = require('cryptr');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

const EMAIL_INDEX_NAME = 'account_email_unique';
const EMAIL_HASH_INDEX_NAME = 'account_email_hash_unique';

const normalizeEmail = (email) => String(email).trim().toLowerCase();
const hashEmail = (email, secret) => crypto.createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex');

// A best-effort detector for an already-encrypted value, so a re-run does not double-encrypt. cryptr's
// output is a long hex string (iv:tag:ciphertext, all hex, well over an email's length and with no
// '@'). A plaintext email always contains '@'. So "no '@' AND long hex" means already-encrypted.
const looksEncrypted = (value) => typeof value === 'string'
   && value.indexOf('@') === -1
   && value.length >= 48
   && /^[0-9a-f]+$/i.test(value);

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      const secret = process.env.SECRET;
      return queryInterface.sequelize.transaction(async (t) => {
         const def = await queryInterface.describeTable('account');

         // 1) Add email_hash (idempotent: only when absent). A real addColumn failure throws.
         if (def && !def.email_hash) {
            await queryInterface.addColumn('account', 'email_hash', {
               type: DataTypes.TEXT,
               allowNull: true,
            }, { transaction: t });
         }

         // The email column was STRING (VARCHAR(255)); ciphertext is longer, so widen it to TEXT to
         // avoid the Postgres truncation class (CLAUDE.md A). changeColumn is idempotent-safe to re-run.
         if (def && def.email) {
            await queryInterface.changeColumn('account', 'email', {
               type: DataTypes.TEXT,
               allowNull: true,
            }, { transaction: t });
         }

         // 2) Drop the OLD unique index on the plaintext email column (ciphertext is non-deterministic,
         //    so uniqueness moves to email_hash). Idempotent: only when present.
         const indexesBefore = await queryInterface.showIndex('account', { transaction: t });
         const hadEmailIndex = Array.isArray(indexesBefore)
            && indexesBefore.some((ix) => ix && ix.name === EMAIL_INDEX_NAME);
         if (hadEmailIndex) {
            await queryInterface.removeIndex('account', EMAIL_INDEX_NAME, { transaction: t });
         }

         // 3) Backfill: for every row with a non-null email, compute email_hash from the PLAINTEXT
         //    email and RE-ENCRYPT the email in place. Skip rows whose email already looks encrypted
         //    (re-run safety). If SECRET is missing we cannot encrypt or hash; throwing here is the
         //    correct fail-loud behavior (never silently leave plaintext / skip uniqueness).
         // The account PK column is "ID" (uppercase, byte-matching the create-account-table migration).
         // Postgres is case-sensitive, so the column MUST be quoted as "ID"; an unquoted id folds to
         // lowercase and throws 'column "id" does not exist' on Postgres (SQLite is case-insensitive and
         // would hide it, the exact test-on-SQLite-prod-on-Postgres trap CLAUDE.md A warns about). The
         // returned row key is therefore ID (row.ID). The :id BIND PARAMETER name is arbitrary and fine.
         const [rows] = await queryInterface.sequelize.query(
            'SELECT "ID", email, email_hash FROM account WHERE email IS NOT NULL',
            { transaction: t },
         );
         if (Array.isArray(rows) && rows.length > 0) {
            if (!secret) {
               throw new Error(
                  'encrypt-account-email: SECRET is required to encrypt existing account emails. Refusing to '
                  + 'proceed and leave plaintext PII at rest. Set SECRET and re-run.',
               );
            }
            const cryptr = new Cryptr(secret);
            for (const row of rows) {
               const current = row.email;
               // Already encrypted (a prior partial run): just ensure the hash exists, do not re-encrypt.
               if (looksEncrypted(current)) {
                  if (!row.email_hash) {
                     // We cannot recover the plaintext to hash it here without decrypting; decrypt to hash.
                     let plain = null;
                     try { plain = cryptr.decrypt(current); } catch (e) { plain = null; }
                     if (plain) {
                        await queryInterface.sequelize.query(
                           'UPDATE account SET email_hash = :h WHERE "ID" = :id',
                           { replacements: { h: hashEmail(plain, secret), id: row.ID }, transaction: t },
                        );
                     }
                  }
                  continue;
               }
               // Plaintext row: compute hash from plaintext, then encrypt the email in place.
               const hash = hashEmail(current, secret);
               const enc = cryptr.encrypt(normalizeEmail(current));
               await queryInterface.sequelize.query(
                  'UPDATE account SET email = :e, email_hash = :h WHERE "ID" = :id',
                  { replacements: { e: enc, h: hash, id: row.ID }, transaction: t },
               );
            }
         }

         // 4) Add the UNIQUE index on email_hash (after backfill, so collisions surface honestly).
         //    Many NULLs are permitted (SQL standard), so email-less accounts are unaffected.
         const indexesAfter = await queryInterface.showIndex('account', { transaction: t });
         const hasHashIndex = Array.isArray(indexesAfter)
            && indexesAfter.some((ix) => ix && ix.name === EMAIL_HASH_INDEX_NAME);
         if (!hasHashIndex) {
            await queryInterface.addIndex('account', ['email_hash'], {
               unique: true,
               name: EMAIL_HASH_INDEX_NAME,
               transaction: t,
            });
         }
      });
   },
   // The down migration restores the plaintext email + its unique index and drops email_hash. It
   // DECRYPTS each encrypted email back to plaintext (best-effort) so a rollback is usable. This is a
   // dev/rollback convenience; it intentionally re-introduces the plaintext-at-rest state it undoes.
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      const secret = process.env.SECRET;
      return queryInterface.sequelize.transaction(async (t) => {
         const def = await queryInterface.describeTable('account');

         // Decrypt emails back to plaintext where possible.
         if (def && def.email && secret) {
            const cryptr = new Cryptr(secret);
            const [rows] = await queryInterface.sequelize.query(
               'SELECT "ID", email FROM account WHERE email IS NOT NULL',
               { transaction: t },
            );
            if (Array.isArray(rows)) {
               for (const row of rows) {
                  if (looksEncrypted(row.email)) {
                     let plain = null;
                     try { plain = cryptr.decrypt(row.email); } catch (e) { plain = null; }
                     if (plain) {
                        await queryInterface.sequelize.query(
                           'UPDATE account SET email = :e WHERE "ID" = :id',
                           { replacements: { e: plain, id: row.ID }, transaction: t },
                        );
                     }
                  }
               }
            }
         }

         const indexes = await queryInterface.showIndex('account', { transaction: t });
         const hasHashIndex = Array.isArray(indexes)
            && indexes.some((ix) => ix && ix.name === EMAIL_HASH_INDEX_NAME);
         if (hasHashIndex) {
            await queryInterface.removeIndex('account', EMAIL_HASH_INDEX_NAME, { transaction: t });
         }
         const hasEmailIndex = Array.isArray(indexes)
            && indexes.some((ix) => ix && ix.name === EMAIL_INDEX_NAME);
         if (!hasEmailIndex) {
            await queryInterface.addIndex('account', ['email'], {
               unique: true,
               name: EMAIL_INDEX_NAME,
               transaction: t,
            });
         }
         if (def && def.email_hash) {
            await queryInterface.removeColumn('account', 'email_hash', { transaction: t });
         }
      });
   },
};
