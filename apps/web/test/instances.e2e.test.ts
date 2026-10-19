import {
  accountAbi,
  createPost,
  SPONSOR_ROUTER_PERMISSIONS,
  textOnlyPost,
  toDataURI,
  type Page,
  type PostView,
} from '@lens-monad/protocol';
import { createWalletClient, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { APP, chainClient, contracts, health, indexed, RPC_URL, user } from './e2e';
import { localTestChain } from '../../../packages/protocol/test/local-chain';

const SECOND = process.env.INSTANCE_TWO_URL;

describe.skipIf(!SECOND)('independent instances sharing one indexer', () => {
  it('shares posts, isolates likes, requires consent to the second router, and honors revocation', async () => {
    const one = (await health()).body;
    const two = (await health(SECOND)).body;
    expect(one.database).toMatchObject({ ok: true, migrated: true });
    expect(two.database).toMatchObject({ ok: true, migrated: true });
    expect(one.sponsorRouter?.toLowerCase()).not.toBe(two.sponsorRouter?.toLowerCase());
    const routerOne = one.sponsorRouter!;
    const routerTwo = two.sponsorRouter!;
    // A full viem account: the test also sends the owner's own transactions with it.
    const aliceAccount = privateKeyToAccount(generatePrivateKey());
    const alice = user(aliceAccount);
    expect((await alice.signIn()).status).toBe(200);
    const signup = await alice.call<{ account: Address; hash: Hex }>('/api/signup', {
      method: 'POST',
      body: { username: `instance${Date.now().toString(36)}` },
    });
    expect(signup.status, signup.body.error).toBe(200);
    const account = signup.body.account;
    const allowed = (router: Address) =>
      chainClient.readContract({
        address: account,
        abi: accountAbi,
        functionName: 'canExecuteTransactions',
        args: [router],
      });
    expect(await allowed(routerOne)).toBe(true);
    expect(await allowed(routerTwo)).toBe(false);
    const call = createPost(
      contracts.LensGlobalFeed,
      account,
      toDataURI(textOnlyPost('A post shared across independent instances'))
    );
    const posted = await alice.call<{ postId: string; hash: Hex }>('/api/relay', {
      method: 'POST',
      body: call,
    });
    expect(posted.status, posted.body.error).toBe(200);
    const transaction = await chainClient.getTransaction({ hash: posted.body.hash });
    expect(transaction.to?.toLowerCase()).toBe(routerOne.toLowerCase());
    expect(one.relayers.map((r) => r.address.toLowerCase())).toContain(
      transaction.from.toLowerCase()
    );
    await indexed<Page<PostView>>(
      `/posts?ids=${posted.body.postId}`,
      (p) => p.items.some((p) => p.id === posted.body.postId),
      SECOND
    );
    const other = user(alice.wallet, SECOND);
    expect((await other.signIn()).status).toBe(200);
    expect(
      (await other.call('/api/auth/session', { method: 'PUT', body: { account } })).status
    ).toBe(200);
    const refused = await other.call('/api/relay', { method: 'POST', body: call });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Instance Two');
    await chainClient.request({
      method: 'anvil_setBalance' as never,
      params: [alice.wallet.address, `0x${parseEther('10').toString(16)}`] as never,
    });
    const owner = createWalletClient({
      chain: localTestChain,
      transport: http(RPC_URL),
      account: aliceAccount,
    });
    const consent = await owner.writeContract({
      address: account,
      abi: accountAbi,
      functionName: 'addAccountManager',
      args: [routerTwo, SPONSOR_ROUTER_PERMISSIONS],
    });
    expect((await chainClient.waitForTransactionReceipt({ hash: consent })).status).toBe('success');
    expect(await allowed(routerTwo)).toBe(true);
    const secondPost = await other.call<{ hash: Hex }>('/api/relay', {
      method: 'POST',
      body: call,
    });
    expect(secondPost.status, secondPost.body.error).toBe(200);
    const secondTx = await chainClient.getTransaction({ hash: secondPost.body.hash });
    expect(secondTx.to?.toLowerCase()).toBe(routerTwo.toLowerCase());
    expect(two.relayers.map((r) => r.address.toLowerCase())).toContain(secondTx.from.toLowerCase());
    const like = await alice.call('/api/likes', {
      method: 'POST',
      body: { postId: posted.body.postId },
    });
    expect(like.status, like.body.error).toBe(200);
    const likesOne = await alice.call(`/api/likes?ids=${posted.body.postId}`);
    const likesTwo = await other.call(`/api/likes?ids=${posted.body.postId}`);
    expect(likesOne.body).not.toEqual(likesTwo.body);
    const revoke = await owner.writeContract({
      address: account,
      abi: accountAbi,
      functionName: 'removeAccountManager',
      args: [routerTwo],
    });
    expect((await chainClient.waitForTransactionReceipt({ hash: revoke })).status).toBe('success');
    expect((await other.call('/api/relay', { method: 'POST', body: call })).status).toBe(403);
    expect((await alice.call('/api/relay', { method: 'POST', body: call })).status).toBe(200);
  }, 120_000);
});
