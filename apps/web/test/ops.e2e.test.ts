// The ops controls, end to end. Always: /api/health and the security headers. Then, for a server started with
// RELAY_PAUSED=true, `E2E_EXPECT=paused`; with SPONSOR_GAS_BUDGET_PER_HOUR=1, `E2E_EXPECT=over-budget`:
//
//   E2E_EXPECT=paused APP_URL=http://localhost:3001 pnpm --filter @lens-monad/web exec vitest run ops.e2e

import { createPost, textOnlyPost, toDataURI } from '@lens-monad/protocol';
import { describe, expect, it } from 'vitest';
import { APP, CHAIN_ID, contracts, health, user } from './e2e';

const EXPECT = process.env.E2E_EXPECT;

describe('ops', () => {
  it('reports health, without secrets', async () => {
    const response = await fetch(`${APP}/api/health`);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(response.status).toBe(body.healthy ? 200 : 503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ chainId: CHAIN_ID, paused: EXPECT === 'paused' });
    expect(body.head).toBeGreaterThan(0);
    expect(body.relayers.length).toBeGreaterThan(0);
    for (const relayer of body.relayers) {
      expect(relayer).toMatchObject({ allowlisted: true, low: false });
    }
    if (body.healthy) {
      expect(body.indexer.lag).toBeGreaterThanOrEqual(0);
    } else {
      expect(body.problems.length).toBeGreaterThan(0);
    }
    // No private key, nor any other 32-byte hex value, nor a URL (an RPC URL can hold an API key).
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('sends the security headers', async () => {
    for (const path of ['/', '/api/health']) {
      const { headers } = await fetch(`${APP}${path}`);
      expect(headers.get('x-frame-options')).toBe('DENY');
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(headers.get('permissions-policy')).toContain('camera=()');
      expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(headers.get('x-powered-by')).toBeNull();
    }
  });

  it.runIf(EXPECT === 'paused')('refuses every sponsored action while paused', async () => {
    const alice = user();
    expect((await alice.signIn()).status).toBe(200);
    const paused = { error: 'Sponsored actions are paused, try again soon' };
    const signUp = await alice.call('/api/signup', {
      method: 'POST',
      body: { username: 'paused' },
    });
    expect(signUp).toMatchObject({ status: 503, body: paused });
    const post = await alice.call('/api/relay', {
      method: 'POST',
      body: createPost(
        contracts.LensGlobalFeed,
        alice.wallet.address,
        toDataURI(textOnlyPost('x'))
      ),
    });
    expect(post).toMatchObject({ status: 503, body: paused });
    const profile = await alice.call('/api/profile', { method: 'POST', body: { name: 'x' } });
    expect(profile).toMatchObject({ status: 503, body: paused });
    expect((await health()).body.paused).toBe(true);
  });

  it.runIf(EXPECT === 'over-budget')(
    'refuses sponsored actions once the budget is spent',
    async () => {
      const alice = user();
      expect((await alice.signIn()).status).toBe(200);
      const signUp = await alice.call('/api/signup', {
        method: 'POST',
        body: { username: `budget${Date.now().toString(36)}` },
      });
      expect(signUp.status).toBe(503);
      expect(signUp.body.error).toMatch(/used up for this hour/);
      const { status, body } = await health();
      expect(status).toBe(503);
      expect(body.problems).toContain("This hour's sponsored gas budget is nearly spent");
    }
  );
});
