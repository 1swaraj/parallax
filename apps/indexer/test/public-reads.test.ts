import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ipBucket, publicReads, readLimiter } from '../src/api/public-reads';

function api(options: Parameters<typeof publicReads>[0] = {}) {
  const app = new Hono();
  app.use('*', publicReads(options));
  app.get('/posts', (c) => c.json({ viewer: c.req.query('viewer') }));
  app.get('/bad', (c) => c.json({ error: 'Bad input' }, 400));
  return app;
}

describe('shared public reads', () => {
  it('allows browser GET and HEAD from any origin without credentials', async () => {
    for (const origin of ['https://instance.one', 'https://instance.two']) {
      const res = await api().request('/posts?viewer=alice', { headers: { origin } });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
      expect(res.headers.get('Cache-Control')).toContain('s-maxage=2');
      expect(await res.json()).toEqual({ viewer: 'alice' });
    }
    expect((await api().request('/posts', { method: 'HEAD' })).status).toBe(200);
  });

  it('answers preflights and refuses writes', async () => {
    const app = api();
    const preflight = await app.request('/posts', {
      method: 'OPTIONS',
      headers: { origin: 'https://instance.one', 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await app.request('/posts', { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('does not cache errors or unknown paths', async () => {
    for (const path of ['/bad', '/missing']) {
      expect((await api().request(path)).headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('limits each trusted IP, returns retry timing, and recovers after the window', async () => {
    let time = 0;
    const app = api({ limit: 2, trustedIpHeader: 'x-client-ip', now: () => time });
    const request = (ip: string) => app.request('/posts', { headers: { 'x-client-ip': ip } });
    expect((await request('192.0.2.1')).status).toBe(200);
    expect((await request('192.0.2.1')).status).toBe(200);
    const refused = await request('192.0.2.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('60');
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(refused.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('192.0.2.2')).status).toBe(200);
    time = 60_000;
    expect((await request('192.0.2.1')).status).toBe(200);
  });

  it('ignores untrusted forwarding headers instead of allowing limit bypass', async () => {
    const app = api({ limit: 1 });
    expect(
      (await app.request('/posts', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status
    ).toBe(200);
    expect(
      (await app.request('/posts', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status
    ).toBe(429);
  });

  it('bounds memory and recovers capacity when idle clients expire', () => {
    let time = 0;
    const allow = readLimiter({ maxClients: 2, now: () => time });
    expect(allow('a').allowed).toBe(true);
    expect(allow('b').allowed).toBe(true);
    expect(allow('c').allowed).toBe(false);
    time = 60_000;
    expect(allow('c').allowed).toBe(true);
  });

  it('refuses invalid limits instead of silently disabling protection', () => {
    for (const limit of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => readLimiter({ limit })).toThrow('positive integers');
    }
  });

  it('normalizes IPv6 /64s and IPv4-mapped IPv6', () => {
    expect(ipBucket('2001:0DB8:0:1::1')).toBe(ipBucket('2001:db8:0:1:ffff::2'));
    expect(ipBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(ipBucket('::ffff:c000:201')).toBe('192.0.2.1');
    expect(ipBucket('bad-ip')).toBe('unknown');
  });
});
