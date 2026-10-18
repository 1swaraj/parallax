// Outside the local chain, sponsored actions refuse to run without the settings that bound the relayers' spending.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingSponsorSettings } from '../src/lib/server/env';
import { assertSponsorshipAvailable } from '../src/lib/server/guard';

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/config')>()),
  IS_LOCAL: false,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

function refusal() {
  try {
    assertSponsorshipAvailable();
    return null;
  } catch (error) {
    return error;
  }
}

describe('sponsorship outside the local chain', () => {
  it('refuses with 503 without a database or a gas budget', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('SPONSOR_GAS_BUDGET_PER_HOUR', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(missingSponsorSettings()).toEqual(['DATABASE_URL', 'SPONSOR_GAS_BUDGET_PER_HOUR']);
    expect(refusal()).toMatchObject({ status: 503, message: "Sponsorship isn't configured" });

    vi.stubEnv('DATABASE_URL', 'postgres://localhost/lens');
    expect(missingSponsorSettings()).toEqual(['SPONSOR_GAS_BUDGET_PER_HOUR']);
    expect(refusal()).toMatchObject({ status: 503 });

    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('SPONSOR_GAS_BUDGET_PER_HOUR', '50_000_000');
    expect(missingSponsorSettings()).toEqual(['DATABASE_URL']);
    expect(refusal()).toMatchObject({ status: 503 });
  });

  it('sponsors with both', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/lens');
    vi.stubEnv('SPONSOR_GAS_BUDGET_PER_HOUR', '50000000');
    vi.stubEnv('RELAY_PAUSED', 'false');
    expect(missingSponsorSettings()).toEqual([]);
    expect(refusal()).toBeNull();
  });

  it('says paused first', () => {
    vi.stubEnv('RELAY_PAUSED', 'true');
    expect(refusal()).toMatchObject({
      status: 503,
      message: 'Sponsored actions are paused, try again soon',
    });
  });
});
