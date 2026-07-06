import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';

// GET / identity response. s33k is headless: there is no web app, so the bare root URL should say
// what this server is instead of 404ing into a Next error page. next.config.js rewrites `/` to
// this route (an afterFiles rewrite: with pages/index.tsx deleted there is no filesystem match for
// `/`, so the rewrite is the cleanest pages-router way to give the root a handler without
// resurrecting a page). Unauthenticated on purpose: it reveals only what the product's README and
// the login-less 401s already reveal, and health checks (docker-compose, render.yaml) probe `/`.
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
   // This route (and the docker-compose/render.yaml healthcheck that probes it) is deliberately
   // DB-free for its own response, but it must still be the request that TRIGGERS the once-per-
   // process [SETUP] boot hook: it is the earliest request a fresh container is guaranteed to
   // receive, ahead of any Bearer-authed /api/* route. ensureSynced is memoized (database/
   // database.ts), so after the first process-wide call this await resolves immediately, keeping
   // the steady-state healthcheck cost a no-op. The [SETUP] line itself prints a few microtask
   // turns after this call returns (announceSetupOnce runs detached off the sync promise, by
   // design, to avoid a recursive deadlock through getStoredSettings -> ensureSynced), well within
   // a healthcheck's polling interval. Swallow a failure: a transient boot-time DB hiccup must not
   // turn the healthcheck itself into a 500, and ensureSynced already clears its own memo on
   // failure so the next call (from this route or any other) retries.
   try {
      await ensureSynced();
   } catch {
      // Intentionally ignored, see comment above.
   }
   res.status(200).json({
      name: 's33k',
      status: 'running',
      message: 's33k is running headless. There is no web dashboard: connect your LLM over MCP and just ask. '
         + 'See https://github.com/benjaminard/s33k for connect instructions. '
         + 'If this instance is new, check the server logs for the one-time [SETUP] link.',
      mcp: '/api/mcp (Streamable HTTP, Authorization: Bearer <APIKEY>)',
   });
};

export default handler;
