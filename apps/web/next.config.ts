import type { NextConfig } from 'next';

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
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default config;
