import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';

/** Bounded process-local window. A full table refuses new clients until a window expires. */
export function readLimiter({
  limit = 600,
  windowMs = 60_000,
  maxClients = 10_000,
  now = Date.now,
} = {}) {
  if (![limit, windowMs, maxClients].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Read limits, window and client capacity must be positive integers');
  }
  const clients = new Map<string, { count: number; until: number }>();
  return (ip: string) => {
    const time = now();
    let entry = clients.get(ip);
    if (!entry || entry.until <= time) {
      // Sweep only when adding a client; the map never grows past maxClients.
      for (const [key, value] of clients) {
        if (value.until <= time) clients.delete(key);
      }
      if (!clients.has(ip) && clients.size >= maxClients) {
        return { allowed: false, retryAfter: 60 };
      }
      entry = { count: 0, until: time + windowMs };
      clients.set(ip, entry);
    }
    entry.count++;
    return {
      allowed: entry.count <= limit,
      retryAfter: Math.max(1, Math.ceil((entry.until - time) / 1000)),
    };
  };
}

/** Canonical IPs; IPv6 shares a /64 so spelling changes and privacy addresses share one limit. */
export function ipBucket(raw: string): string {
  if (isIP(raw) === 4) return raw;
  if (isIP(raw) !== 6) return 'unknown';
  // URL canonicalization also folds hexadecimal IPv4-mapped addresses into the same bucket.
  const ip = new URL(`http://[${raw.split('%')[0]}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/i.exec(ip);
  if (mapped) {
    const bits = parseInt(mapped[1]!, 16) * 65536 + parseInt(mapped[2]!, 16);
    return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join('.');
  }
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  return (
    [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      .slice(0, 4)
      .map((part) => parseInt(part, 16).toString(16))
      .join(':') + '::/64'
  );
}

/** REST reads only. Ponder handles its built-in /health, /ready, /status before this middleware. */
export function publicReads(
  options: {
    limit?: number;
    trustedIpHeader?: string;
    now?: () => number;
  } = {}
): MiddlewareHandler {
  const allow = readLimiter({ limit: options.limit, now: options.now });
  return async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    c.header('Access-Control-Expose-Headers', 'Retry-After');
    c.header('Cache-Control', 'no-store');
    // Trust forwarding headers only when the operator's edge overwrites that header.
    const socketIp = c.env?.incoming?.socket?.remoteAddress ?? '';
    const forwarded = options.trustedIpHeader ? c.req.header(options.trustedIpHeader) : undefined;
    const result = allow(ipBucket(forwarded?.trim() || socketIp));
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfter));
      return c.json({ error: 'Too many requests' }, 429);
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      c.header('Allow', 'GET, HEAD, OPTIONS');
      return c.json({ error: 'Read-only API' }, 405);
    }
    await next();
    if (c.res.status === 200) {
      c.header('Cache-Control', 'public, max-age=2, s-maxage=2, stale-while-revalidate=3');
    }
  };
}
