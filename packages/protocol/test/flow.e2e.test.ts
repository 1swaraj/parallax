import { localTestChain } from './local-chain';
// End-to-end flow against a local node with Lens deployed (`pnpm chain`): sponsored sign-up, posts, replies,
// reposts, follows and blocks through SponsorRouter, then the same calls sent directly by the Account's owner.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  accountAbi,
  accountBlockingRuleAbi,
  accountFactoryAbi,
  blockAccount,
  createAccountWithUsernameArgs,
  createPost,
  deletePost,
  directExecution,
  feedAbi,
  follow,
  getDeployment,
  graphAbi,
  lensFactoryAbi,
  namespaceAbi,
  readPostContent,
  repost,
  sponsorRouterAbi,
  textOnlyPost,
  toDataURI,
  accountMetadata,
  type AccountCall,
} from '../src';

// Anvil's 4th account, the relayer DeployLaunch allowlists on chain 31337.
const RELAYER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

const { contracts } = getDeployment(localTestChain.id);
const publicClient = createPublicClient({
  chain: localTestChain,
  transport: http(localTestChain.rpcUrls.default.http[0]),
  pollingInterval: 100,
});
const relayer = createWalletClient({
  chain: localTestChain,
  transport: http(localTestChain.rpcUrls.default.http[0]),
  account: privateKeyToAccount(RELAYER_KEY),
  pollingInterval: 100,
});

const gasUsed: Record<string, bigint> = {};

async function signUp(label: string) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const username = `${label}${Date.now().toString(36)}`;
  const args = createAccountWithUsernameArgs({
    namespace: contracts.LensGlobalNamespace,
    owner: owner.address,
    username,
    metadataURI: toDataURI(accountMetadata({ name: label })),
    sponsorRouter: contracts.SponsorRouter,
  });
  const hash = await relayer.writeContract({
    address: contracts.LensFactory,
    abi: lensFactoryAbi,
    functionName: 'createAccountWithUsernameFree',
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  gasUsed.signUp = receipt.gasUsed;
  const [created] = parseEventLogs({
    abi: accountFactoryAbi,
    eventName: 'Lens_Account_Created',
    logs: receipt.logs,
  });
  return { owner, username, account: created!.args.account };
}

async function sponsored(account: Address, call: AccountCall, label?: string) {
  const hash = await relayer.writeContract({
    address: contracts.SponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'execute',
    args: [account, call.target, call.data],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  if (label) {
    gasUsed[label] = receipt.gasUsed;
  }
  return receipt;
}

function postIdOf(logs: Parameters<typeof parseEventLogs>[0]['logs']) {
  const [event] = parseEventLogs({ abi: feedAbi, eventName: 'Lens_Feed_PostCreated', logs });
  return event!.args;
}

describe('Lens on a local Monad node', () => {
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  let alicePostId: bigint;

  beforeAll(async () => {
    const code = await publicClient
      .getCode({ address: contracts.SponsorRouter })
      .catch(() => undefined);
    if (!code || code === '0x') {
      throw new Error('Lens is not deployed on http://127.0.0.1:8545, run `pnpm chain` first');
    }
    alice = await signUp('alice');
    bob = await signUp('bob');
  });

  it('creates Accounts owned by MON-less EOAs, with their usernames and SponsorRouter as manager', async () => {
    expect(await publicClient.getBalance({ address: alice.owner.address })).toBe(0n);
    const owner = await publicClient.readContract({
      address: alice.account,
      abi: accountAbi,
      functionName: 'owner',
    });
    expect(owner).toBe(alice.owner.address);
    const accountOfUsername = await publicClient.readContract({
      address: contracts.LensGlobalNamespace,
      abi: namespaceAbi,
      functionName: 'accountOf',
      args: [alice.username],
    });
    expect(accountOfUsername).toBe(alice.account);
    const routerCanExecute = await publicClient.readContract({
      address: alice.account,
      abi: accountAbi,
      functionName: 'canExecuteTransactions',
      args: [contracts.SponsorRouter],
    });
    expect(routerCanExecute).toBe(true);
  });

  it('posts through the router, with the content inline', async () => {
    const contentURI = toDataURI(textOnlyPost('gm from Monad ✨'));
    const receipt = await sponsored(
      alice.account,
      createPost(contracts.LensGlobalFeed, alice.account, contentURI),
      'post'
    );
    const event = postIdOf(receipt.logs);
    expect(event.author).toBe(alice.account);
    expect(readPostContent(event.postParams.contentURI)).toBe('gm from Monad ✨');
    alicePostId = event.postId;
  });

  it('follows, replies to and reposts through the router', async () => {
    await sponsored(
      bob.account,
      follow(contracts.LensGlobalGraph, bob.account, alice.account),
      'follow'
    );
    const isFollowing = await publicClient.readContract({
      address: contracts.LensGlobalGraph,
      abi: graphAbi,
      functionName: 'isFollowing',
      args: [bob.account, alice.account],
    });
    expect(isFollowing).toBe(true);

    const reply = postIdOf(
      (
        await sponsored(
          bob.account,
          createPost(contracts.LensGlobalFeed, bob.account, toDataURI(textOnlyPost('gm alice')), {
            kind: 'reply',
            postId: alicePostId,
          }),
          'reply'
        )
      ).logs
    );
    expect(reply.rootPostId).toBe(alicePostId);
    expect(reply.postParams.repliedPostId).toBe(alicePostId);

    const reposted = postIdOf(
      (await sponsored(bob.account, repost(contracts.LensGlobalFeed, bob.account, alicePostId)))
        .logs
    );
    expect(reposted.postParams.repostedPostId).toBe(alicePostId);
  });

  it('blocks through the router', async () => {
    await sponsored(
      alice.account,
      blockAccount(contracts.AccountBlockingRule, alice.account, bob.account),
      'block'
    );
    const isBlocked = await publicClient.readContract({
      address: contracts.AccountBlockingRule,
      abi: accountBlockingRuleAbi,
      functionName: 'isBlocked',
      args: [alice.account, bob.account],
    });
    expect(isBlocked).toBe(true);
  });

  it("can't act as another Account, nor call functions outside the allowlist", async () => {
    // Bob's Account calling createPost with Alice as author: the Feed requires msg.sender == author.
    await expect(
      publicClient.simulateContract({
        account: relayer.account,
        address: contracts.SponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'execute',
        args: [
          bob.account,
          ...(Object.values(createPost(contracts.LensGlobalFeed, alice.account, 'x')) as [
            Address,
            Hex,
          ]),
        ],
      })
    ).rejects.toThrow();
    // Adding a manager isn't allowlisted.
    await expect(
      publicClient.simulateContract({
        account: relayer.account,
        address: contracts.SponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'execute',
        args: [alice.account, alice.account, '0x'],
      })
    ).rejects.toThrow();
  });

  it("lets the Account's owner act directly, paying in MON", async () => {
    await publicClient.request({
      method: 'anvil_setBalance' as never,
      params: [alice.owner.address, `0x${parseEther('1').toString(16)}`] as never,
    });
    const owner = createWalletClient({
      chain: localTestChain,
      transport: http(localTestChain.rpcUrls.default.http[0]),
      account: alice.owner,
    });
    const hash = await owner.sendTransaction({
      to: alice.account,
      data: directExecution(deletePost(contracts.LensGlobalFeed, alicePostId)),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const exists = await publicClient.readContract({
      address: contracts.LensGlobalFeed,
      abi: feedAbi,
      functionName: 'postExists',
      args: [alicePostId],
    });
    expect(exists).toBe(false);
  });

  it('reports the gas used', () => {
    console.table(
      Object.fromEntries(Object.entries(gasUsed).map(([label, gas]) => [label, gas.toString()]))
    );
  });
});
