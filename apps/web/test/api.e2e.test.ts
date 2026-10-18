// End-to-end test of the app's server against the local stack (`pnpm chain`, `pnpm indexer`, and the app on
// http://localhost:3000, or APP_URL): SIWE sign-in, sponsored sign-up, posts and follows relayed through the
// SponsorRouter, and the guards. The users' wallets hold no MON: the relayer pays for everything.

import {
  createAndAssignUsername,
  createPost,
  feedAbi,
  follow,
  textOnlyPost,
  toDataURI,
  type PostView,
  type ProfileView,
  type Page,
} from '@lens-monad/protocol';
import { encodeFunctionData, zeroHash } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { describe, expect, it } from 'vitest';
import { APP, CHAIN_ID, contracts, indexed, user } from './e2e';

const FEED = contracts.LensGlobalFeed;
const GRAPH = contracts.LensGlobalGraph;

describe('the app server, sponsored', () => {
  const alice = user();
  const bob = user();
  const aliceName = `alice${Date.now().toString(36)}`;
  const bobName = `bob${Date.now().toString(36)}`;
  let aliceAccount: `0x${string}`;
  let bobAccount: `0x${string}`;

  it('signs in with SIWE, then signs up for free', async () => {
    const signedIn = await alice.signIn();
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ owner: alice.wallet.address, account: null });

    const signUp = await alice.call<{ account: `0x${string}` }>('/api/signup', {
      method: 'POST',
      body: { username: aliceName, name: 'Alice', bio: 'gm' },
    });
    expect(signUp.status, signUp.body.error).toBe(200);
    aliceAccount = signUp.body.account;
    const profile = await indexed<ProfileView>(`/accounts/${aliceName}`, () => true);
    expect(profile.account).toMatchObject({
      address: aliceAccount,
      owner: alice.wallet.address,
      name: 'Alice',
      sponsored: true,
    });

    expect((await bob.signIn()).status).toBe(200);
    const bobSignUp = await bob.call<{ account: `0x${string}` }>('/api/signup', {
      method: 'POST',
      body: { username: bobName },
    });
    expect(bobSignUp.status, bobSignUp.body.error).toBe(200);
    bobAccount = bobSignUp.body.account;
  });

  it('a new sign-in finds the account the wallet owns', async () => {
    const again = await alice.signIn();
    expect(again.body.account).toBe(aliceAccount);
  });

  it('posts and follows through the relayer', async () => {
    const post = await alice.call('/api/relay', {
      method: 'POST',
      body: createPost(FEED, aliceAccount, toDataURI(textOnlyPost('first post, gas-free'))),
    });
    expect(post.status, post.body.error).toBe(200);
    const posts = await indexed<Page<PostView>>(
      `/accounts/${aliceName}/posts`,
      (page) => page.items.length > 0
    );
    expect(posts.items[0]!.content).toBe('first post, gas-free');

    const followed = await bob.call('/api/relay', {
      method: 'POST',
      body: follow(GRAPH, bobAccount, aliceAccount),
    });
    expect(followed.status, followed.body.error).toBe(200);
    const profile = await indexed<ProfileView>(
      `/accounts/${aliceName}?viewer=${bobAccount}`,
      (p) => !!p.relationship?.following
    );
    expect(profile.account.followers).toBe(1);

    const again = await bob.call('/api/relay', {
      method: 'POST',
      body: follow(GRAPH, bobAccount, aliceAccount),
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('You already follow this account.');
  });

  it('updates the profile through the relayer', async () => {
    const updated = await alice.call('/api/profile', {
      method: 'POST',
      body: { name: 'Alice 🌙', bio: 'building on Monad' },
    });
    expect(updated.status, updated.body.error).toBe(200);
    const profile = await indexed<ProfileView>(
      `/accounts/${aliceName}`,
      (p) => p.account.name === 'Alice 🌙'
    );
    expect(profile.account.bio).toBe('building on Monad');
  });

  it("can't act for another account, nor call anything else", async () => {
    // Bob's session, Alice as author: the Feed requires msg.sender == author.
    const impersonation = await bob.call('/api/relay', {
      method: 'POST',
      body: createPost(FEED, aliceAccount, toDataURI(textOnlyPost('not alice'))),
    });
    expect(impersonation.status).toBe(400);
    expect(impersonation.body.error).toBe("This account can't act for another one.");

    const otherTarget = await bob.call('/api/relay', {
      method: 'POST',
      body: { target: bobAccount, data: '0x12345678' },
    });
    expect(otherTarget.status).toBe(400);

    // The SponsorRouter allows it, the app never sends it: free usernames, minted on the relayer's gas.
    const username = await bob.call('/api/relay', {
      method: 'POST',
      body: createAndAssignUsername(
        contracts.LensGlobalNamespace,
        bobAccount,
        `free${Date.now().toString(36)}`
      ),
    });
    expect(username).toMatchObject({
      status: 400,
      body: { error: "That action can't be sponsored" },
    });

    const withRule = await bob.call('/api/relay', {
      method: 'POST',
      body: {
        target: FEED,
        data: encodeFunctionData({
          abi: feedAbi,
          functionName: 'createPost',
          args: [
            {
              author: bobAccount,
              contentURI: toDataURI(textOnlyPost('with a rule')),
              repostedPostId: 0n,
              quotedPostId: 0n,
              repliedPostId: 0n,
              ruleChanges: [
                {
                  ruleAddress: contracts.AccountBlockingRule,
                  configSalt: zeroHash,
                  configurationChanges: { configure: true, ruleParams: [] },
                  selectorChanges: [],
                },
              ],
              extraData: [],
            },
            [],
            [],
            [],
            [],
          ],
        }),
      },
    });
    expect(withRule).toMatchObject({
      status: 400,
      body: { error: "Posts with rules can't be sponsored" },
    });

    const badPicture = await alice.call('/api/profile', {
      method: 'POST',
      body: { picture: 'javascript:alert(1)' },
    });
    expect(badPicture.status).toBe(400);
  });

  it('rejects cross-origin requests, replayed nonces, stale sign-ins and signed-out sessions', async () => {
    const crossOrigin = await alice.call('/api/relay', {
      method: 'POST',
      origin: 'https://evil.example',
      body: createPost(FEED, aliceAccount, toDataURI(textOnlyPost('csrf'))),
    });
    expect(crossOrigin.status).toBe(403);

    // A signature for a nonce that was already used.
    const mallory = user();
    const { body } = await mallory.call<{ nonce: string }>('/api/auth/nonce');
    const message = createSiweMessage({
      address: mallory.wallet.address,
      chainId: CHAIN_ID,
      domain: new URL(APP).host,
      uri: APP,
      nonce: body.nonce,
      version: '1',
    });
    const signature = await mallory.wallet.signMessage({ message });
    expect(
      (await mallory.call('/api/auth/verify', { method: 'POST', body: { message, signature } }))
        .status
    ).toBe(200);
    expect(
      (await mallory.call('/api/auth/verify', { method: 'POST', body: { message, signature } }))
        .status
    ).toBe(400);

    // A message issued more than 10 minutes ago, with a fresh nonce.
    const fresh = await mallory.call<{ nonce: string }>('/api/auth/nonce');
    const stale = createSiweMessage({
      address: mallory.wallet.address,
      chainId: CHAIN_ID,
      domain: new URL(APP).host,
      uri: APP,
      nonce: fresh.body.nonce,
      version: '1',
      issuedAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const staleSignIn = await mallory.call('/api/auth/verify', {
      method: 'POST',
      body: { message: stale, signature: await mallory.wallet.signMessage({ message: stale }) },
    });
    expect(staleSignIn).toMatchObject({
      status: 400,
      body: { error: 'This sign-in request expired, try again.' },
    });

    expect((await alice.call('/api/auth/session', { method: 'DELETE', body: {} })).status).toBe(
      200
    );
    const signedOut = await alice.call('/api/relay', {
      method: 'POST',
      body: createPost(FEED, aliceAccount, toDataURI(textOnlyPost('signed out'))),
    });
    expect(signedOut.status).toBe(401);
  });
});
