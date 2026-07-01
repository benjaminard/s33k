// Migration: Creates the `rate_limit` table (the shared-store fixed-window rate-limit counters).
//
// WHY: utils/rate-limit.ts is PER-PROCESS in memory. Under horizontal scaling (N instances) every
// limit becomes limit*N, and the per-EMAIL magic-link brake (3/hour) degrades worst (3*N links to a
// victim's inbox). This table is the cross-process backing store: ONE row per namespaced key, mutated
// by a single atomic UPSERT (utils/rate-limit-store.ts), so a window is authoritative across every
// instance. Used only when RATE_LIMIT_BACKEND='postgres'; the default 'memory' backend never touches it.
//
// Column names/types BYTE-MATCH database/models/rateLimit.ts (Postgres is case-sensitive):
//   "key"          TEXT  PRIMARY KEY  the namespaced bucket key; PK so the UPSERT resolves ON CONFLICT
//                                     ("key"). TEXT (never STRING/VARCHAR(255)) so a long bearer-derived
//                                     key cannot truncate on Postgres (the truncation class in CLAUDE.md).
//   "window_start" BIGINT  not null   epoch-ms start of the current fixed window. BIGINT because epoch ms
//                                     overflows INT4 on Postgres.
//   "count"        INTEGER not null   hits accounted in the current window.
// "key" is a SQL reserved word; createTable quotes identifiers itself, so the column is created safely,
// and the raw UPSERT in the store always quotes it. timestamps:false on the model, so NO createdAt/
// updatedAt columns are created (this table is pure counters, not an audited record).
//
// The TEXT "key" PRIMARY KEY already gives the unique index the UPSERT's ON CONFLICT needs, so no
// separate addIndex is required; the PK constraint is the unique index on "key".
//
// FAIL-LOUD + IDEMPOTENT, dual-convention (Umzug v3 { context } and classic positional). The
// describeTable idempotency probe is the only swallowing try/catch (a missing table throws there =
// "not yet created"). createTable is UNWRAPPED so a real failure throws out of up() and stays
// retryable (entrypoint.sh exits non-zero on a migrate failure rather than booting against a bad schema).

const { DataTypes } = require('sequelize');

const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         let exists = false;
         try {
            await queryInterface.describeTable('rate_limit');
            exists = true;
         } catch (describeError) {
            exists = false;
         }
         if (!exists) {
            await queryInterface.createTable('rate_limit', {
               key: {
                  type: DataTypes.TEXT, allowNull: false, primaryKey: true,
               },
               window_start: { type: DataTypes.BIGINT, allowNull: false },
               count: { type: DataTypes.INTEGER, allowNull: false },
            }, { transaction: t });
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('rate_limit');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('rate_limit', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
