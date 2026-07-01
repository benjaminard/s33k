// Use Postgres when DATABASE_URL is set (hosted deploy), otherwise SQLite (local dev).
const config = process.env.DATABASE_URL
  ? {
    url: process.env.DATABASE_URL,
    dialect: 'postgres',
    dialectOptions: {},
  }
  : {
    database: 'sequelize',
    dialect: 'sqlite',
    storage: process.env.DATABASE_PATH || './data/database.sqlite',
    dialectOptions: {
      bigNumberStrings: true,
    },
  };

module.exports = {
  development: config,
  production: config,
};
