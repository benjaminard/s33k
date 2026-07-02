import type { NextApiRequest, NextApiResponse } from 'next';

// GET / identity response. s33k is headless: there is no web app, so the bare root URL should say
// what this server is instead of 404ing into a Next error page. next.config.js rewrites `/` to
// this route (an afterFiles rewrite: with pages/index.tsx deleted there is no filesystem match for
// `/`, so the rewrite is the cleanest pages-router way to give the root a handler without
// resurrecting a page). Unauthenticated on purpose: it reveals only what the product's README and
// the login-less 401s already reveal, and health checks (docker-compose, render.yaml) probe `/`.
const handler = (req: NextApiRequest, res: NextApiResponse) => {
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
