// The request guards that don't need a chain: same-origin writes, sign-up IP buckets, SIWE freshness, the health
// token, the session secret, and sponsorship's settings on the local chain.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingSponsorSettings, sessionSecret } from '../src/lib/server/env';
import { assertSameOrigin, assertSponsorshipAvailable } from '../src/lib/server/guard';
import { canSeeHealthDetails } from '../src/lib/server/health';
import { clientIpKey } from '../src/lib/server/requests';
import { isFreshSignIn, NONCE_TTL_MS } from '../src/lib/server/session';

afterEach(() => {
  vi.unstubAllEnvs();
});

function from(forwardedFor?: string) {
  return new Request('http://localhost/api/signup', {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
}

function write(origin: string | null, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/auth/verify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...headers,
    },
  });
}

describe('assertSameOrigin', () => {
  it('takes writes from the host the request names, and refuses other origins', () => {
    expect(() =>
      assertSameOrigin(write('http://localhost:3000', { host: 'localhost:3000' }))
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(
        write('https://app.example', { host: 'localhost:3000', 'x-forwarded-host': 'app.example' })
      )
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(write('https://evil.example', { host: 'localhost:3000' }))
    ).toThrow('Cross-origin request');
    expect(() => assertSameOrigin(write(null, { host: 'localhost:3000' }))).toThrow(
      'Cross-origin request'
    );
  });

  it("trusts the app's URL over Host, for proxies that don't forward it", () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://preview.example');
    expect(() =>
      assertSameOrigin(write('https://preview.example', { host: 'localhost:3000' }))
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(write('http://localhost:3000', { host: 'localhost:3000' }))
    ).toThrow('Cross-origin request');
  });
});

describe('clientIpKey', () => {
  it('keeps IPv4 addresses, the first of a forwarded list', () => {
    expect(clientIpKey(from('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIpKey(from(' 203.0.113.7 , 10.0.0.1'))).toBe('203.0.113.7');
    expect(clientIpKey(from('::ffff:203.0.113.7'))).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by /64, however they are written', () => {
    const key = '2001:db8:aa:1::/64';
    expect(clientIpKey(from('2001:db8:aa:1::1'))).toBe(key);
    expect(clientIpKey(from('2001:db8:aa:1:ffff:ffff:ffff:ffff'))).toBe(key);
    expect(clientIpKey(from('2001:0DB8:00AA:0001:0:0:0:2'))).toBe(key);
    expect(clientIpKey(from('2001:db8:aa:1::192.0.2.1'))).toBe(key);
    expect(clientIpKey(from('fe80::1%eth0'))).toBe('fe80:0:0:0::/64');
    expect(clientIpKey(from('2001:db8:aa:2::1'))).not.toBe(key);
    expect(clientIpKey(from('2001:db8::'))).toBe('2001:db8:0:0::/64');
    expect(clientIpKey(from('::1'))).toBe('0:0:0:0::/64');
  });

  it('puts requests without a usable address in one shared bucket', () => {
    expect(clientIpKey(from())).toBe('unknown');
    expect(clientIpKey(from(''))).toBe('unknown');
    expect(clientIpKey(from('not an ip'))).toBe('unknown');
  });
});

describe('isFreshSignIn', () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  const minutesAgo = (minutes: number) => now - minutes * 60_000;

  it('accepts a nonce and a message from the last 10 minutes', () => {
    expect(isFreshSignIn(minutesAgo(1), new Date(minutesAgo(1)), now)).toBe(true);
    expect(isFreshSignIn(now - NONCE_TTL_MS, new Date(now - NONCE_TTL_MS), now)).toBe(true);
    // The wallet's clock can run a little ahead.
    expect(isFreshSignIn(minutesAgo(0), new Date(minutesAgo(-0.5)), now)).toBe(true);
  });

  it('refuses an expired nonce, an old or future message, and a message without a time', () => {
    expect(isFreshSignIn(minutesAgo(11), new Date(minutesAgo(1)), now)).toBe(false);
    expect(isFreshSignIn(undefined, new Date(minutesAgo(1)), now)).toBe(false);
    expect(isFreshSignIn(minutesAgo(1), new Date(minutesAgo(11)), now)).toBe(false);
    expect(isFreshSignIn(minutesAgo(1), new Date(minutesAgo(-2)), now)).toBe(false);
    expect(isFreshSignIn(minutesAgo(1), undefined, now)).toBe(false);
    expect(isFreshSignIn(minutesAgo(1), new Date(Number.NaN), now)).toBe(false);
  });
});

describe('canSeeHealthDetails', () => {
  it('takes the bearer token, when one is set', () => {
    vi.stubEnv('HEALTH_TOKEN', 'correct-horse-battery-staple');
    expect(canSeeHealthDetails('Bearer correct-horse-battery-staple')).toBe(true);
    expect(canSeeHealthDetails('bearer correct-horse-battery-staple')).toBe(true);
    expect(canSeeHealthDetails('Bearer correct-horse-battery')).toBe(false);
    expect(canSeeHealthDetails('Bearer correct-horse-battery-staplex')).toBe(false);
    expect(canSeeHealthDetails('correct-horse-battery-staple')).toBe(false);
    expect(canSeeHealthDetails('Bearer ')).toBe(false);
    expect(canSeeHealthDetails(null)).toBe(false);
  });

  it('shows nobody the details without a token', () => {
    vi.stubEnv('HEALTH_TOKEN', '');
    expect(canSeeHealthDetails('Bearer ')).toBe(false);
    expect(canSeeHealthDetails('Bearer undefined')).toBe(false);
  });
});

describe('sessionSecret', () => {
  it('uses the local default on chain 31337, but never on Vercel', () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('VERCEL', '');
    expect(sessionSecret()).toHaveLength(48);
    vi.stubEnv('VERCEL', '1');
    expect(() => sessionSecret()).toThrow(
      'INSTANCE_SECRET or SESSION_SECRET must be set on Vercel'
    );
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
    expect(sessionSecret()).toBe('x'.repeat(32));
  });
});

describe('sponsorship on the local chain', () => {
  it('needs neither a database nor a budget', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('SPONSOR_GAS_BUDGET_PER_HOUR', '');
    vi.stubEnv('RELAY_PAUSED', 'false');
    expect(missingSponsorSettings()).toEqual([]);
    expect(() => assertSponsorshipAvailable()).not.toThrow();
  });
});
