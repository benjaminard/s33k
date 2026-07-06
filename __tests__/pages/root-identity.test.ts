import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The / identity response (headless build).
 *
 * The web UI is deleted, so next.config.js rewrites `/` to /api/root, which must return a small,
 * unauthenticated 200 identity payload: what this server is, that the product is the MCP surface,
 * and where a fresh install finds its one-time [SETUP] link. Health checks (docker-compose wget,
 * render.yaml healthCheckPath: /) also probe this, so the 200 is load-bearing.
 *
 * It must ALSO be the request that guarantees the [SETUP] line has printed by the time a healthcheck
 * first passes (issue: the DB-free `/` / healthcheck never triggered the once-per-process
 * ensureSynced() boot hook, so a fresh headless install's `[SETUP]` link never appeared). The
 * handler therefore awaits ensureSynced() before responding; the tests below cover both the
 * lightweight mock (call is made, a sync failure does not 500 the healthcheck) and a real
 * integration through database/database + utils/setupState (the announce actually fires).
 */

const makeReqRes = () => {
   const req = { headers: {}, method: 'GET', url: '/' } as unknown as NextApiRequest;
   const captured: { status?: number, body?: Record<string, unknown> } = {};
   const res = {
      status(code: number) { captured.status = code; return this; },
      json(body: Record<string, unknown>) { captured.body = body; return this; },
      setHeader: () => undefined,
      getHeader: () => undefined,
   } as unknown as NextApiResponse;
   return { req, res, captured };
};

describe('GET / identity response (/api/root)', () => {
   const ensureSyncedMock = jest.fn().mockResolvedValue(undefined);

   beforeEach(() => {
      jest.resetModules();
      ensureSyncedMock.mockReset().mockResolvedValue(undefined);
      jest.doMock('../../database/database', () => ({
         __esModule: true,
         default: { sync: jest.fn().mockResolvedValue(undefined) },
         ensureSynced: ensureSyncedMock,
      }));
   });

   const loadHandler = () => {
      // eslint-disable-next-line global-require
      return require('../../pages/api/root').default;
   };

   it('returns 200 with the headless identity payload, no auth required', async () => {
      const handler = loadHandler();
      const { req, res, captured } = makeReqRes();
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body).toBeDefined();
      expect(captured.body!.name).toBe('s33k');
      expect(String(captured.body!.message)).toContain('headless');
      expect(String(captured.body!.message)).toContain('[SETUP]');
      expect(String(captured.body!.mcp)).toContain('/api/mcp');
   });

   it('never leaks a secret: the payload carries no key material', async () => {
      process.env.APIKEY = 'super-secret-key-value';
      const handler = loadHandler();
      const { req, res, captured } = makeReqRes();
      await handler(req, res);
      expect(JSON.stringify(captured.body)).not.toContain('super-secret-key-value');
      delete process.env.APIKEY;
   });

   it('the next.config.js rewrite maps / to /api/root', () => {
      // Lock the wiring, not just the handler: if the rewrite disappears, / becomes a Next 404.
      // eslint-disable-next-line global-require
      const nextConfig = require('../../next.config.js');
      return nextConfig.rewrites().then((rewrites: Array<{ source: string, destination: string }>) => {
         expect(rewrites).toEqual(expect.arrayContaining([{ source: '/', destination: '/api/root' }]));
      });
   });

   it('awaits the once-per-process ensureSynced() boot hook before responding', async () => {
      const handler = loadHandler();
      const { req, res, captured } = makeReqRes();
      await handler(req, res);
      expect(ensureSyncedMock).toHaveBeenCalledTimes(1);
      expect(captured.status).toBe(200);
   });

   it('still returns 200 when ensureSynced() rejects: a boot-time DB hiccup must not 500 the healthcheck', async () => {
      ensureSyncedMock.mockRejectedValueOnce(new Error('db not ready'));
      const handler = loadHandler();
      const { req, res, captured } = makeReqRes();
      await handler(req, res);
      expect(captured.status).toBe(200);
   });
});

describe('GET /api/root causes the [SETUP] announcement (real ensureSynced + setupState wiring)', () => {
   // Mirrors __tests__/database/ensure-synced.test.ts: mock the DB driver layer so the real
   // database.ts / utils/setupState.ts run unmodified, and mock the settings store so a fresh,
   // setup-incomplete instance is simulated (the same seam __tests__/utils/setup-state.test.ts uses).
   const syncMock = jest.fn().mockResolvedValue(undefined);
   const mockRead = jest.fn().mockResolvedValue({});

   beforeEach(() => {
      jest.resetModules();
      syncMock.mockReset().mockResolvedValue(undefined);
      mockRead.mockReset().mockResolvedValue({});

      // The first describe block above mocks '../../database/database' wholesale via jest.doMock,
      // which (unlike jest.mock) is not undone by jest.resetModules(): it would otherwise still
      // shadow the real module here, so this suite gets the actual database.ts + setupState.ts wiring.
      jest.dontMock('../../database/database');
      jest.doMock('sequelize-typescript', () => ({
         __esModule: true,
         Sequelize: jest.fn().mockImplementation(() => ({ sync: syncMock })),
      }));
      jest.doMock('sqlite3', () => ({ __esModule: true, default: {} }));
      jest.doMock('pg', () => ({ __esModule: true, default: {} }));
      const modelStub = { __esModule: true, default: {} };
      jest.doMock('../../database/models/domain', () => ({ __esModule: true, default: { count: jest.fn().mockResolvedValue(0) } }));
      jest.doMock('../../database/models/keyword', () => modelStub);
      jest.doMock('../../database/models/crawlerHit', () => modelStub);
      jest.doMock('../../database/models/s33kEvent', () => modelStub);
      jest.doMock('../../database/models/goal', () => modelStub);
      jest.doMock('../../database/models/segment', () => modelStub);
      jest.doMock('../../database/models/promptCheck', () => modelStub);
      jest.doMock('../../database/models/setting', () => modelStub);
      jest.doMock('../../utils/settingsStore', () => ({
         __esModule: true,
         getStoredSettings: mockRead,
         writeStoredSettings: jest.fn().mockResolvedValue(undefined),
      }));
   });

   // announceSetupOnce is a deliberate no-op under NODE_ENV=test (see utils/setupState.ts), so lift
   // it to development for this one assertion, restoring it afterward like setup-state.test.ts does.
   const withDevEnv = async (fn: () => Promise<void>) => {
      const prior = process.env.NODE_ENV;
      (process.env as Record<string, string>).NODE_ENV = 'development';
      try { await fn(); } finally { (process.env as Record<string, string>).NODE_ENV = prior as string; }
   };

   // database.ts fires the announce off the sync promise WITHOUT awaiting it (on purpose: awaiting
   // it inline would recurse into ensureSynced() again via getStoredSettings and deadlock, see
   // CLAUDE.md). So the [SETUP] line lands a few microtask turns after the response, not before it.
   // A real healthcheck polls every 30s, plenty of margin; the test just flushes the microtask queue.
   const flushAsync = async () => {
      for (let i = 0; i < 5; i += 1) { await new Promise((resolve) => { setImmediate(resolve); }); }
   };

   it('prints the [SETUP] token URL the first time /api/root is hit on a fresh, setup-incomplete instance', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await withDevEnv(async () => {
         // eslint-disable-next-line global-require
         const handler = require('../../pages/api/root').default;
         const { req, res, captured } = makeReqRes();
         await handler(req, res);
         expect(captured.status).toBe(200);
         await flushAsync();
      });
      const setupLines = spy.mock.calls.filter((c) => String(c[0]).startsWith('[SETUP]'));
      expect(setupLines).toHaveLength(1);
      spy.mockRestore();
   });

   it('prints nothing once setup is already completed', async () => {
      mockRead.mockResolvedValue({ setup_completed: true });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await withDevEnv(async () => {
         // eslint-disable-next-line global-require
         const handler = require('../../pages/api/root').default;
         const { req, res } = makeReqRes();
         await handler(req, res);
         await flushAsync();
      });
      expect(spy.mock.calls.filter((c) => String(c[0]).startsWith('[SETUP]'))).toHaveLength(0);
      spy.mockRestore();
   });
});
