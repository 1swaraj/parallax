// Mirror mode (lib/config.ts): the server takes nothing that writes, and the app reads the chain's mirror. The mode is
// read at build time, so each test loads the app fresh with its environment.

import { getMirrorDeployment } from '@lens-monad/protocol';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyModeration } from '../src/lib/moderation-policy';

vi.mock('../src/lib/server/moderation', () => ({
  moderationSnapshot: async () => emptyModeration(),
}));

async function load(mirror: boolean) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_MIRROR', mirror ? 'true' : '');
  return {
    ...(await import('../src/proxy')),
    ...(await import('../src/lib/config')),
  };
}

const request = (method: string, path: string) =>
  new NextRequest(`http://localhost:3000${path}`, { method });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mirror mode', () => {
  it('reads the chain’s mirror rather than its launch deployment', async () => {
    const { deployment, MIRROR } = await load(true);
    expect(MIRROR).toBe(true);
    expect(deployment).toEqual(getMirrorDeployment(31337));
    expect(deployment.contracts).toHaveProperty('MigrationAccountDeployer');
    expect((await load(false)).deployment.contracts).not.toHaveProperty('MigrationAccountDeployer');
  });

  it('refuses what writes Lens, likes and digests, before any route runs', async () => {
    const { proxy } = await load(true);
    for (const [method, path] of [
      ['POST', '/api/relay'],
      ['POST', '/api/signup'],
      ['PUT', '/api/signup'],
      ['POST', '/api/profile'],
      ['POST', '/api/likes'],
      ['DELETE', '/api/likes'],
      ['POST', '/api/email'],
      ['DELETE', '/api/email'],
    ] as const) {
      const response = await proxy(request(method, path));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).error).toContain('read-only mirror');
    }
  });

  it('lets reads, signing in, reports and unsubscribing through', async () => {
    const { proxy } = await load(true);
    for (const [method, path] of [
      ['GET', '/api/likes'],
      ['GET', '/api/signup'],
      ['GET', '/api/auth/nonce'],
      ['POST', '/api/auth/verify'],
      ['POST', '/api/reports'],
      ['POST', '/api/email/unsubscribe'],
      ['GET', '/indexer/mirror'],
    ] as const) {
      expect((await proxy(request(method, path))).status, `${method} ${path}`).toBe(200);
    }
  });

  it('leaves the launch deployment’s client as it is', async () => {
    const { proxy, MIRROR } = await load(false);
    expect(MIRROR).toBe(false);
    expect((await proxy(request('POST', '/api/relay'))).status).toBe(200);
  });

  it('serves the mirror’s sync status through the indexer proxy', async () => {
    await load(true);
    const { proxyIndexer } = await import('../src/lib/server/indexer-proxy');
    const status = { accounts: 9, posts: 22, lensChainPosts: '22' };
    const send = vi.fn<typeof fetch>(async () => Response.json(status));
    const response = await proxyIndexer(
      new Request('https://app.example/indexer/mirror'),
      ['mirror'],
      send
    );
    expect(send.mock.calls[0]![0]).toMatch(/\/mirror\?$/);
    expect(await response.json()).toEqual(status);
  });

  it('says how far the history’s sync is', async () => {
    await load(true);
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { HistorySync } = await import('../src/components/mirror');
    const status = {
      accounts: 873_000,
      accountReads: 0,
      posts: 3_100_000,
      lensChainPosts: '21400000',
      follows: 0,
      usernames: 0,
      blocks: 0,
      oldestPostAt: String(Date.UTC(2025, 2, 4, 12) / 1000),
      newestPostAt: null,
      notifySince: null,
      lastImportBlock: null,
      lastImportAt: null,
    };
    const syncing = renderToStaticMarkup(createElement(HistorySync, { status }));
    expect(syncing).toContain('3.1M of 21.4M posts copied, back to Mar 4, 2025');
    expect(syncing).toContain('14.5%');
    expect(syncing).toContain('aria-valuenow="14"');
    expect(
      renderToStaticMarkup(createElement(HistorySync, { status: { ...status, posts: 21_400_000 } }))
    ).toContain('History synced');
    expect(
      renderToStaticMarkup(
        createElement(HistorySync, { status: { ...status, posts: 0, lensChainPosts: null } })
      )
    ).toContain('History syncing:</span> starting');
  });
});
