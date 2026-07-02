// eslint-disable-next-line no-unused-vars
import 'isomorphic-fetch';
import { enableFetchMocks } from 'jest-fetch-mock';

// Default-mock DNS resolution. utils/site-crawl.ts now resolves each hostname and
// rejects any that maps to a private IP (SSRF defense, security review #1). Unit tests
// mock global.fetch with fixture hostnames (e.g. blog.example, thin-site.example) that do
// not resolve, so without this they would be correctly blocked before any fetch. Return a
// fixed public IP by default; an SSRF-specific test can override this to assert that a
// hostname resolving to a private address is rejected.
jest.mock('dns/promises', () => ({
   __esModule: true,
   lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

// Enable Fetch Mocking
enableFetchMocks();

// The prebuilt-report routes (weekly-digest, executive-summary, seo-report, aeo-report,
// site-audit) share a module-level in-memory TTL cache (utils/report-cache). Tests call a
// handler many times with the SAME tenant + domain + params in one process and expect each
// call to recompute, so without this a second case would receive the first case's cached
// payload. Clearing before every test restores the cold-start behavior the route tests assume.
// This is harness-only: production behavior is unchanged, and report-cache imports only the
// dependency-free scope helper, so requiring it here drags no DB/ESM into the setup file.
// eslint-disable-next-line global-require
const reportCache = require('./utils/report-cache');
beforeEach(() => { reportCache.clear(); });
