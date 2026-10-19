import type { NextConfig } from 'next';

const isLocalChain = (process.env.NEXT_PUBLIC_CHAIN_ID ?? '31337') === '31337';

// Rewrites are compiled into the build, so INDEXER_URL must be set when building (on Vercel: for every environment
// that builds), not only at runtime. Without it, a production build would proxy /indexer to localhost.
if (!process.env.INDEXER_URL && !isLocalChain) {
  throw new Error('INDEXER_URL must be set to build for a chain other than 31337');
}
const indexerUrl = (process.env.INDEXER_URL ?? 'http://127.0.0.1:42069').replace(/\/+$/, '');

// No script-src: Next's inline scripts would need a nonce from a proxy, which makes every page dynamic, and
// 'unsafe-inline' would defeat it. These directives don't touch scripts or wallets: no framing (clickjacking), no
// <base> or plugin injection, forms post to the app only.
const CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // usb and hid stay allowed: some hardware wallet connectors use them from the page.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()',
  },
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
];

const config: NextConfig = {
  // Lets several builds coexist locally (e.g. NEXT_DIST_DIR=.next-api).
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  transpilePackages: ['@lens-monad/protocol'],
  poweredByHeader: false,
  // `next dev` only: other hosts that may load the dev server's resources (hot reload), e.g. a tunnel's or a preview
  // URL's host. Comma-separated.
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(',').filter(Boolean),
  // The browser reads the indexer through the app's origin, so the indexer needs no CORS. Post images are at /media
  // on the app's origin: the URL their Lens metadata gives other apps.
  async rewrites() {
    return [
      { source: '/indexer/:path*', destination: `${indexerUrl}/:path*` },
      { source: '/media/:path*', destination: `${indexerUrl}/media/:path*` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default config;
