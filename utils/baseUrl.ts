import type { NextApiRequest } from 'next';

// Resolve the public base URL of this s33k instance for building user-facing links
// (e.g. the invite-accept page link we email out) and the minted mcpConfig.S33K_BASE_URL.
// Precedence: prefer the explicit NEXT_PUBLIC_APP_URL (most reliable behind a reverse proxy and
// the only header-INDEPENDENT source); then, in DEV ONLY, fall back to the X-Forwarded-* headers
// and req.headers.host. Returns a value with any trailing slash stripped.
//
// SECURITY (host-header poisoning, audit area 1): this value is baked into emailed invite/login/
// share links and the minted mcpConfig.S33K_BASE_URL (which carries the connecting client's Bearer
// key). Deriving it from attacker-controllable Host / X-Forwarded-Host headers in production is
// unacceptable: a forged Host could point a victim's MCP client or emailed link at an attacker host
// (link/credential exfiltration). So in PRODUCTION this resolver is FAIL-CLOSED: when
// NEXT_PUBLIC_APP_URL is unset it NEVER consults request headers and instead throws, refusing to
// mint a link. In a correctly-booted prod instance this throw is unreachable, because entrypoint.sh
// refuses to boot in production without NEXT_PUBLIC_APP_URL set (the boot-time assertion is the
// primary guard; this throw is the defense-in-depth backstop that makes the misconfiguration a hard
// failure instead of a silent header-poisoning hole). The dev/localhost header fallback is kept so
// local development needs no extra config.
export const resolveBaseUrl = (req: NextApiRequest): string => {
   const configured = process.env.NEXT_PUBLIC_APP_URL;
   if (configured && configured.trim()) {
      return configured.trim().replace(/\/$/, '');
   }
   if (process.env.NODE_ENV === 'production') {
      // Fail closed: do NOT read any request header in production. A header-derived base could be
      // forged and would leak into key-bearing links. Refuse to build the link instead.
      throw new Error('[SECURITY] NEXT_PUBLIC_APP_URL is unset in production. Refusing to build a'
         + ' user-facing link from request headers (host-header-poisoning exposed). Set'
         + ' NEXT_PUBLIC_APP_URL to your real public URL (see DEPLOY.md) and redeploy.');
   }
   // Dev only: header / localhost fallback so local development works without extra config.
   const fwdProto = req.headers['x-forwarded-proto'] as string | undefined;
   const fwdHost = req.headers['x-forwarded-host'] as string | undefined;
   const host = fwdHost || req.headers.host || 'localhost:3000';
   const proto = fwdProto || (host.includes('localhost:') ? 'http' : 'https');
   return `${proto}://${host}`.replace(/\/$/, '');
};

export default resolveBaseUrl;
