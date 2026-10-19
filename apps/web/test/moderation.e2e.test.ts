// Run against the full local Lens stack and an isolated managed app database:
// MODERATION_E2E_DATABASE_URL=postgres://... HEALTH_TOKEN=... pnpm --filter @lens-monad/web test:e2e
// Uses only Anvil's documented test mnemonic; never run policy-changing tests against a shared deployment.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { createTestClient, http, pad, toHex } from 'viem';
import {
  createPost,
  textOnlyPost,
  toDataURI,
  type Page,
  type PostView,
} from '@lens-monad/protocol';
import { APP, CHAIN_ID, contracts, indexed, RPC_URL, user, chainClient } from './e2e';
import { connect, migrate, type Sql } from '../src/lib/server/db';
import type { ModerationPolicy } from '../src/lib/moderation-policy';

const databaseUrl = process.env.MODERATION_E2E_DATABASE_URL;
describe.skipIf(CHAIN_ID !== 31337 || !databaseUrl)('moderation on the local chain', () => {
  const operator = user(
    mnemonicToAccount('test test test test test test test test test test test junk')
  );
  const invited = user(
      mnemonicToAccount('test test test test test test test test test test test junk', {
        addressIndex: 5,
      })
    ),
    gated = user(
      mnemonicToAccount('test test test test test test test test test test test junk', {
        addressIndex: 6,
      })
    );
  let sql: Sql,
    original: ModerationPolicy,
    invitedAccount: `0x${string}`,
    gatedAccount: `0x${string}`,
    postId: string;
  const testChain = createTestClient({ mode: 'anvil', transport: http(RPC_URL) });
  const token = '0x000000000000000000000000000000000000c0de';
  const name = (prefix: string) => `${prefix}${Date.now().toString(36)}`;
  async function policy(patch: Partial<ModerationPolicy>) {
    const result = await operator.call('/api/admin/config', {
      method: 'PUT',
      body: { moderation: { ...original, ...patch } },
    });
    expect(result.status, result.body.error).toBe(200);
  }
  async function action(body: unknown) {
    const result = await operator.call<{ codes: string[] }>('/api/admin/moderation', {
      method: 'POST',
      body,
    });
    expect(result.status, result.body.error).toBe(200);
    return result.body;
  }
  beforeAll(async () => {
    if (new URL(APP).hostname !== 'localhost' && new URL(APP).hostname !== '127.0.0.1')
      throw new Error('Moderation E2E requires a local app');
    if (
      (await chainClient.getCode({ address: contracts.LensFactory })) === '0x' ||
      !(await chainClient.getCode({ address: contracts.LensFactory }))
    )
      throw new Error(
        'Lens is not deployed locally; the full protocol checkout and indexer are required'
      );
    sql = connect(databaseUrl!);
    await migrate(sql);
    await sql`INSERT INTO lens_web.instance_admins (address, role) VALUES (${operator.wallet.address.toLowerCase()}, 'admin') ON CONFLICT DO NOTHING`;
    expect((await operator.signIn()).status).toBe(200);
    const response = await operator.call<{ config: { moderation: ModerationPolicy } }>(
      '/api/admin/config'
    );
    original = response.body.config.moderation;
  });
  afterAll(async () => {
    if (original) await policy(original);
    if (sql) await sql.end();
  });

  it('admits an invite-only signup and records the redemption', async () => {
    await policy({ signupMode: 'invite', externalAccounts: 'allow', turnstileEnabled: false });
    const { codes } = await action({
      action: 'invites',
      count: 1,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect((await invited.signIn()).status).toBe(200);
    const username = name('invited');
    expect((await invited.call('/api/signup', { method: 'POST', body: { username } })).status).toBe(
      403
    );
    const result = await invited.call<{ account: `0x${string}` }>('/api/signup', {
      method: 'POST',
      body: { username, inviteCode: codes[0] },
    });
    expect(result.status, result.body.error).toBe(200);
    invitedAccount = result.body.account;
  });
  it('checks a token gate on signup and session refresh via real eth_call', async () => {
    // A private, local-only balance fixture: balanceOf returns storage slot zero. No shared contract is changed.
    await testChain.setCode({ address: token, bytecode: '0x60005460005260206000f3' });
    await testChain.setStorageAt({ address: token, index: pad('0x00'), value: pad('0x00') });
    await policy({
      signupMode: 'token',
      turnstileEnabled: false,
      token: { address: token, standard: 'erc20', minimum: '5', tokenId: '0' },
    });
    expect((await gated.signIn()).status).toBe(200);
    const username = name('gated');
    expect((await gated.call('/api/signup', { method: 'POST', body: { username } })).status).toBe(
      403
    );
    await testChain.setStorageAt({ address: token, index: pad('0x00'), value: pad(toHex(5)) });
    // Changing the configured threshold gives this balance check a new cache key.
    await policy({
      signupMode: 'token',
      token: { address: token, standard: 'erc20', minimum: '4', tokenId: '0' },
    });
    const result = await gated.call<{ account: `0x${string}` }>('/api/signup', {
      method: 'POST',
      body: { username },
    });
    expect(result.status, result.body.error).toBe(200);
    gatedAccount = result.body.account;
    await testChain.setStorageAt({ address: token, index: pad('0x00'), value: pad('0x00') });
    await policy({
      signupMode: 'token',
      token: { address: token, standard: 'erc20', minimum: '3', tokenId: '0' },
    });
    expect((await gated.call('/api/auth/session')).status).toBe(403);
    await policy({ signupMode: 'open', turnstileEnabled: false });
  });
  it('refuses a filtered word on relay before sending', async () => {
    await action({
      action: 'filter',
      filter: { kind: 'word', pattern: 'e2e-forbidden-word', action: 'block', reason: 'E2E rule' },
    });
    expect(
      (
        await invited.call('/api/relay', {
          method: 'POST',
          body: createPost(
            contracts.LensGlobalFeed,
            invitedAccount,
            toDataURI(textOnlyPost('e2e-forbidden-word'))
          ),
        })
      ).status
    ).toBe(403);
  });
  it('report → queue → hide removes a post from timeline/search and redacts its thread', async () => {
    const content = `moderatione2e${Date.now()}`;
    const posted = await invited.call<{ postId: string }>('/api/relay', {
      method: 'POST',
      body: createPost(contracts.LensGlobalFeed, invitedAccount, toDataURI(textOnlyPost(content))),
    });
    expect(posted.status, posted.body.error).toBe(200);
    postId = posted.body.postId;
    await indexed<Page<PostView>>(`/search/posts?q=${content}`, (page) =>
      page.items.some((post) => post.id === postId)
    );
    expect(
      (
        await gated.call('/api/reports', {
          method: 'POST',
          body: { targetType: 'post', target: postId, reason: 'spam' },
        })
      ).status
    ).toBe(200);
    const reports = await operator.call<{ reports: { id: string }[] }>(
      `/api/admin/moderation?target=${postId}`
    );
    expect(reports.body.reports).toHaveLength(1);
    await action({
      action: 'reports',
      ids: [reports.body.reports[0]!.id],
      operation: 'hide',
      reason: 'Confirmed spam',
    });
    for (const path of ['/timeline', `/search/posts?q=${content}`])
      expect(
        (await invited.call<Page<PostView>>(`/indexer${path}`)).body.items.some(
          (post) => post.id === postId
        )
      ).toBe(false);
    const thread = await invited.call<{ post: PostView }>(`/indexer/posts/${postId}`);
    expect(thread.body.post.moderation?.hidden).toBe(true);
    expect(thread.body.post.content).toBeNull();
  });
  it('refuses suspended sessions, relay and new sign-ins', async () => {
    await action({
      action: 'account',
      target: invitedAccount,
      operation: 'suspend',
      reason: 'E2E suspension',
    });
    expect((await invited.call('/api/auth/session')).status).toBe(403);
    expect(
      (
        await invited.call('/api/relay', {
          method: 'POST',
          body: createPost(
            contracts.LensGlobalFeed,
            invitedAccount,
            toDataURI(textOnlyPost('refused'))
          ),
        })
      ).status
    ).toBe(403);
    expect((await invited.signIn()).status).toBe(403);
  });
});
