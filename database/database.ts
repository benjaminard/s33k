import { Sequelize } from 'sequelize-typescript';
import sqlite3 from 'sqlite3';
import pg from 'pg';
import Domain from './models/domain';
import Keyword from './models/keyword';
import CrawlerHit from './models/crawlerHit';
import S33kEvent from './models/s33kEvent';
import Goal from './models/goal';
import Segment from './models/segment';
import PromptCheck from './models/promptCheck';
import Setting from './models/setting';

// Single-user schema: only the tables the app actually uses. The SaaS tables (account, api_key,
// invite, waitlist, feature_request, audit_log, rate_limit) are gone. The account.ts / apiKey.ts
// model FILES stay on disk as type-only dependencies for the ~80 routes that annotate a param as
// Account, but they are NOT synced/created here, so a fresh single-user install has no dead tables.
const models = [
   Domain, Keyword, CrawlerHit, S33kEvent, Goal, Segment, PromptCheck, Setting,
];
// DB_POOL_MAX makes the connection-pool ceiling tunable for higher tenant load; default 5 keeps
// the prior behavior byte-for-byte when unset. acquire:30000 fails a saturated pool fast (30s)
// instead of hanging a request indefinitely.
const pool = {
   max: Number(process.env.DB_POOL_MAX) || 5, min: 0, idle: 10000, acquire: 30000,
};

// Use Postgres when DATABASE_URL is set (hosted deploy), otherwise SQLite (local dev).
const connection = process.env.DATABASE_URL
   ? new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      dialectModule: pg,
      pool,
      logging: false,
      models,
   })
   : new Sequelize({
      dialect: 'sqlite',
      dialectModule: sqlite3,
      pool,
      logging: false,
      models,
      storage: process.env.DATABASE_PATH || './data/database.sqlite',
   });

// Memoized one-time schema sync.
//
// SECURITY (DoS amplification, audit area 1): route handlers used to `await db.sync()` on EVERY
// request. On Postgres a no-force sync still issues a metadata round-trip for all registered
// models, so an unauthenticated flood of a PUBLIC endpoint (collect / waitlist / invite-accept)
// forced ~11 catalog queries per hit against a 5-connection pool BEFORE the rate limiter could
// reject it. Migrations already run on boot via entrypoint.sh (sequelize-cli db:migrate), so a
// runtime sync is only a cold-start safety net, never needed per request. ensureSynced() runs the
// sync exactly once per process and is a cheap awaited no-op on every call after the first, so the
// per-request cost collapses to nothing while behavior stays identical (the schema is still ensured
// before the first query). Callers replace `await db.sync()` with `await ensureSynced()`.
let syncOnce: Promise<void> | null = null;
export const ensureSynced = (): Promise<void> => {
   if (!syncOnce) {
      syncOnce = connection.sync().then(() => undefined).catch((error) => {
         // Do not cache a failed sync: clear the memo so the next request retries rather than being
         // permanently wedged by one transient failure at boot (e.g. the DB not yet accepting calls).
         syncOnce = null;
         throw error;
      });
   }
   return syncOnce;
};

export default connection;
