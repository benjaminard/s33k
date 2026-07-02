/** @type {import('next').NextConfig} */
const { version } = require('./package.json');

const nextConfig = {
  reactStrictMode: true,
  swcMinify: false,
  output: 'standalone',
  // Do not advertise the framework (audit area 4). X-Powered-By: Next.js lets an attacker
  // fingerprint the exact stack; suppress it. No functional effect.
  poweredByHeader: false,
  serverRuntimeConfig: {
    appURL: process.env.NEXT_PUBLIC_APP_URL || '',
  },
  publicRuntimeConfig: {
   version,
 },
  // Headless: the web UI is deleted, so `/` has no page. Rewrite it to the identity API route so
  // the root returns a small JSON "this is s33k, connect over MCP" response instead of a Next 404.
  // A plain (afterFiles) rewrite is enough: nothing in pages/ or public/ matches `/` anymore, so
  // this always applies, and it keeps the identity response an API handler rather than a page.
  async rewrites() {
    return [
      { source: '/', destination: '/api/root' },
    ];
  },
  // Baseline security response headers on every route. Intentionally NO Content-Security-Policy
  // and NO Cross-Origin-Embedder/Opener or Access-Control headers: the first-party tracker
  // (/s33k.js loaded via <script> on customer sites, beacons POSTed to /api/collect) is a
  // cross-origin embed, so a wrong CSP/COEP/COOP/CORS default would silently break the product.
  // The headers below are all safe for cross-origin <script> loads and sendBeacon/fetch POSTs:
  // X-Frame-Options only blocks iframe embedding of the app UI, not script loads or beacons.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // HSTS: 2 years, subdomains, preload-eligible. Only honored over HTTPS (prod is HTTPS).
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
