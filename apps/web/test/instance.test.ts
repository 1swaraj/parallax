import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../src/app/api/instance/route';
import { contracts } from '../src/lib/config';
import { databaseUrl, sessionSecret } from '../src/lib/server/env';
import { getSponsorshipConfig } from '../src/lib/server/sponsorship-config';

afterEach(() => vi.unstubAllEnvs());

describe('instance sponsorship config', () => {
  it('bootstraps from the address book and allows an operator override', async () => {
    vi.stubEnv('SPONSOR_ROUTER_ADDRESS', '');
    expect((await getSponsorshipConfig()).sponsorRouter).toBe(contracts.SponsorRouter);
    vi.stubEnv('SPONSOR_ROUTER_ADDRESS', '0x0000000000000000000000000000000000001234');
    vi.stubEnv('APP_NAME', 'Community');
    expect(await getSponsorshipConfig()).toEqual({
      name: 'Community',
      sponsorRouter: '0x0000000000000000000000000000000000001234',
    });
  });
  it('fails closed for invalid or zero router overrides', async () => {
    for (const value of ['bad', '0x0000000000000000000000000000000000000000']) {
      vi.stubEnv('SPONSOR_ROUTER_ADDRESS', value);
      await expect(getSponsorshipConfig()).rejects.toThrow('SPONSOR_ROUTER_ADDRESS');
    }
  });
  it('exposes only the public name and router, without caching', async () => {
    const res = await GET();
    expect(Object.keys(await res.json()).sort()).toEqual(['name', 'sponsorRouter']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('supports Neon and existing database variables with explicit precedence', () => {
    vi.stubEnv('POSTGRES_URL', 'postgres://compat');
    vi.stubEnv('DATABASE_URL', '');
    expect(databaseUrl()).toBe('postgres://compat');
    vi.stubEnv('DATABASE_URL', 'postgres://primary');
    expect(databaseUrl()).toBe('postgres://primary');
  });
  it('bootstraps sessions from INSTANCE_SECRET while retaining SESSION_SECRET override', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('INSTANCE_SECRET', 'a'.repeat(64));
    expect(sessionSecret()).toBe('a'.repeat(64));
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(64));
    expect(sessionSecret()).toBe('b'.repeat(64));
  });
});
