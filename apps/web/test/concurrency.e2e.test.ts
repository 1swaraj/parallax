// Concurrent sponsored actions, end to end: many accounts sign up and post at the same time, across several relayers
// (RELAYER_PRIVATE_KEYS with 2+ allowlisted keys). Every request must succeed: a nonce collision would fail one. Each
// transaction must come from the relayer the account hashes to.

import { createPost, textOnlyPost, toDataURI } from '@lens-monad/protocol';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { relayerIndex } from '../src/lib/server/relayers';
import { chainClient, contracts, RELAYERS, user } from './e2e';

const relayers = RELAYERS.map((relayer) => relayer.address);

function expectedRelayer(actor: Address) {
  return relayers[relayerIndex(actor, relayers.length)]!;
}

async function sender(hash: Hex) {
  return getAddress((await chainClient.getTransaction({ hash })).from);
}

/** Wallets whose sign-ups spread evenly over the relayers (sign-ups go by owner). */
function walletsAcrossRelayers(count: number) {
  const wallets = [];
  while (wallets.length < count) {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const index = relayerIndex(wallet.address, relayers.length);
    if (
      wallets.filter((w) => relayerIndex(w.address, relayers.length) === index).length <
      count / relayers.length
    ) {
      wallets.push(wallet);
    }
  }
  return wallets;
}

type Member = ReturnType<typeof user> & { account: Address };

/** Signs users in and up, all at once. */
async function signUpAll(count: number): Promise<Member[]> {
  const users = walletsAcrossRelayers(count).map((wallet) => user(wallet));
  for (const u of users) {
    expect((await u.signIn()).status).toBe(200);
  }
  const suffix = Date.now().toString(36);
  const signUps = await Promise.all(
    users.map((u, i) =>
      u.call<{ account: Address; hash: Hex }>('/api/signup', {
        method: 'POST',
        body: { username: `crowd${suffix}${i}` },
      })
    )
  );
  for (const [i, signUp] of signUps.entries()) {
    expect(signUp.status, signUp.body.error).toBe(200);
    expect(await sender(signUp.body.hash)).toBe(expectedRelayer(users[i]!.wallet.address));
  }
  return users.map((u, i) => Object.assign(u, { account: signUps[i]!.body.account }));
}

describe('concurrent sponsored actions', () => {
  it('runs with several relayers', () => {
    // Start the app with 2+ allowlisted keys in RELAYER_PRIVATE_KEYS.
    expect(relayers.length).toBeGreaterThan(1);
  });

  it('signs up and posts for 8 accounts at once, from the relayer each account maps to', async () => {
    const members = await signUpAll(8);
    // The accounts' addresses come from the factory: make sure they cover every relayer.
    for (let round = 0; round < 3; round++) {
      const covered = new Set(members.map((m) => expectedRelayer(m.account)));
      if (covered.size === relayers.length) break;
      members.push(...(await signUpAll(4)));
    }

    // Two posts per account, all at once: 16+ transactions racing for the relayers' nonces.
    const posts = await Promise.all(
      members.flatMap((member) =>
        [1, 2].map((n) =>
          member.call<{ hash: Hex }>('/api/relay', {
            method: 'POST',
            body: createPost(
              contracts.LensGlobalFeed,
              member.account,
              toDataURI(textOnlyPost(`concurrent post ${n}`))
            ),
          })
        )
      )
    );
    const senders = new Set<string>();
    for (const [i, post] of posts.entries()) {
      expect(post.status, post.body.error).toBe(200);
      const member = members[Math.floor(i / 2)]!;
      const from = await sender(post.body.hash);
      expect(from).toBe(expectedRelayer(member.account));
      senders.add(from);
    }
    expect(senders.size).toBe(relayers.length);
  });
});
