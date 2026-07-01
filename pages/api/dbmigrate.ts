import { Sequelize } from 'sequelize';
import { Umzug, SequelizeStorage } from 'umzug';
import type { NextApiRequest, NextApiResponse } from 'next';
import pg from 'pg';
import { ensureSynced } from '../../database/database';
import verifyUser from '../../utils/verifyUser';

// LEGACY ADMIN MIGRATION ENDPOINT. This is intentionally still behind verifyUser and the route
// whitelist rather than authorize(): it is an instance-level maintenance action, not tenant data.
// It should stay narrow, never accept arbitrary migration names or paths, and never become reachable
// from read-only member/share keys.

// Build a Sequelize instance for migrations: Postgres when DATABASE_URL is set, else SQLite.
const makeSequelize = () => (process.env.DATABASE_URL
   ? new Sequelize(process.env.DATABASE_URL, { dialect: 'postgres', dialectModule: pg, logging: false })
   : new Sequelize({ dialect: 'sqlite', storage: process.env.DATABASE_PATH || './data/database.sqlite', logging: false }));

type MigrationGetResponse = {
   hasMigrations: boolean,
}

type MigrationPostResponse = {
   migrated: boolean,
   error?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const authorized = verifyUser(req, res);
   if (authorized === 'authorized' && req.method === 'GET') {
      await ensureSynced();
      return getMigrationStatus(req, res);
   }
   if (authorized === 'authorized' && req.method === 'POST') {
      return migrateDatabase(req, res);
   }
   return res.status(401).json({ error: authorized });
}

const getMigrationStatus = async (req: NextApiRequest, res: NextApiResponse<MigrationGetResponse>) => {
   const sequelize = makeSequelize();
   const umzug = new Umzug({
      migrations: { glob: 'database/migrations/*.js' },
      context: sequelize.getQueryInterface(),
      storage: new SequelizeStorage({ sequelize }),
      logger: undefined,
   });
   const migrations = await umzug.pending();
   // console.log('migrations :', migrations);
   return res.status(200).json({ hasMigrations: migrations.length > 0 });
};

const migrateDatabase = async (req: NextApiRequest, res: NextApiResponse<MigrationPostResponse>) => {
   const sequelize = makeSequelize();
   const umzug = new Umzug({
      migrations: { glob: 'database/migrations/*.js' },
      context: sequelize.getQueryInterface(),
      storage: new SequelizeStorage({ sequelize }),
      logger: undefined,
   });
   const migrations = await umzug.up();
   console.log('[Updated] migrations :', migrations);
   return res.status(200).json({ migrated: true });
};
