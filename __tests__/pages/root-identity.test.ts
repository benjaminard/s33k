import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/root';

/**
 * The / identity response (headless build).
 *
 * The web UI is deleted, so next.config.js rewrites `/` to /api/root, which must return a small,
 * unauthenticated 200 identity payload: what this server is, that the product is the MCP surface,
 * and where a fresh install finds its one-time [SETUP] link. Health checks (docker-compose wget,
 * render.yaml healthCheckPath: /) also probe this, so the 200 is load-bearing.
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
   it('returns 200 with the headless identity payload, no auth required', () => {
      const { req, res, captured } = makeReqRes();
      handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body).toBeDefined();
      expect(captured.body!.name).toBe('s33k');
      expect(String(captured.body!.message)).toContain('headless');
      expect(String(captured.body!.message)).toContain('[SETUP]');
      expect(String(captured.body!.mcp)).toContain('/api/mcp');
   });

   it('never leaks a secret: the payload carries no key material', () => {
      process.env.APIKEY = 'super-secret-key-value';
      const { req, res, captured } = makeReqRes();
      handler(req, res);
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
});
