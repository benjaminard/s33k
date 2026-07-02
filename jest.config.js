const nextJest = require('next/jest');
require('dotenv').config({ path: './.env.local' });

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
});

// Add any custom config to be passed to Jest
/** @type {import('jest').Config} */
const customJestConfig = {
  // Add more setup options before each test is run
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // if using TypeScript with a baseUrl set to the root directory then you need the below for alias' to work
  moduleDirectories: ['node_modules', '<rootDir>/'],
  // The suite is API/server-side only since the web UI was deleted (headless phase), so tests run
  // under node. The one test that needs a DOM (the beacon test, __tests__/public/) constructs its
  // own isolated JSDOM instances explicitly rather than relying on a jsdom test environment.
  testEnvironment: 'node',
  // The standalone build (output: 'standalone') copies the mcp workspace into
  // .next/standalone/mcp, whose package.json collides with the real mcp/package.json under
  // jest-haste-map. Ignore the build output so the collision warning never appears and a stale
  // copy can never shadow the real module during resolution.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
};

module.exports = createJestConfig(customJestConfig);
