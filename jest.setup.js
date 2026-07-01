// eslint-disable-next-line no-unused-vars
import 'isomorphic-fetch';
import './styles/globals.css';
import '@testing-library/jest-dom';
import { enableFetchMocks } from 'jest-fetch-mock';
// Optional: configure or set up a testing framework before each test.
// If you delete this file, remove `setupFilesAfterEnv` from `jest.config.js`

// Used for __tests__/testing-library.js
// Learn more: https://github.com/testing-library/jest-dom

window.matchMedia = (query) => ({
   matches: false,
   media: query,
   onchange: null,
   addListener: jest.fn(), // deprecated
   removeListener: jest.fn(), // deprecated
   addEventListener: jest.fn(),
   removeEventListener: jest.fn(),
   dispatchEvent: jest.fn(),
});

global.ResizeObserver = require('resize-observer-polyfill');

// jsdom (Node 20) does not provide TextEncoder/TextDecoder globally, which MSW
// (pulled in by __mocks__/utils.tsx) requires at import time. Polyfill from Node's util.
if (typeof global.TextEncoder === 'undefined' || typeof global.TextDecoder === 'undefined') {
   // eslint-disable-next-line global-require
   const { TextEncoder, TextDecoder } = require('util');
   global.TextEncoder = global.TextEncoder || TextEncoder;
   global.TextDecoder = global.TextDecoder || TextDecoder;
}

// jsdom also lacks BroadcastChannel, which MSW references at import time. Node 20
// provides it via worker_threads.
if (typeof global.BroadcastChannel === 'undefined') {
   // eslint-disable-next-line global-require
   const { BroadcastChannel } = require('worker_threads');
   global.BroadcastChannel = BroadcastChannel;
}

// jsdom does not expose the WHATWG stream globals that MSW's SSE/fetch interceptors
// reference at import time. Node 20 provides them via stream/web.
if (typeof global.ReadableStream === 'undefined'
   || typeof global.WritableStream === 'undefined'
   || typeof global.TransformStream === 'undefined') {
   // eslint-disable-next-line global-require
   const { ReadableStream, WritableStream, TransformStream } = require('stream/web');
   global.ReadableStream = global.ReadableStream || ReadableStream;
   global.WritableStream = global.WritableStream || WritableStream;
   global.TransformStream = global.TransformStream || TransformStream;
}

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
