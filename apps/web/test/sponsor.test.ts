// What the relayers pay for: the calls /api/relay accepts, and the gas limit any sponsored transaction may have.

import {
  blockAccount,
  createAndAssignUsername,
  createPost,
  deletePost,
  feedAbi,
  follow,
  repost,
  sponsorRouterAbi,
  unblockAccount,
  unfollow,
  type AccountCall,
} from '@lens-monad/protocol';
import { encodeFunctionData, zeroHash } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contracts } from '../src/lib/config';
import { publicClient, sendAsRelayer } from '../src/lib/server/chain';
import { maxGasPerSignUp, maxGasPerTransaction } from '../src/lib/server/env';
import { HttpError } from '../src/lib/server/guard';
import { assertSponsoredCall } from '../src/lib/server/sponsor';
import { serverState } from '../src/lib/server/state';
import { randomAddress } from './helpers';

const FEED = contracts.LensGlobalFeed;
const GRAPH = contracts.LensGlobalGraph;
const BLOCKING = contracts.AccountBlockingRule;
const [me, them] = [randomAddress(), randomAddress()];
const content = 'data:application/json,{}';

function refused(call: AccountCall, message = "Parallax can't pay the fee of that action") {
  let error: unknown;
  try {
    assertSponsoredCall(call.target, call.data);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ status: 400, message });
}

/** A createPost that also attaches a rule contract to the new post. */
function postWithRule(rule = randomAddress()): AccountCall {
  return {
    target: FEED,
    data: encodeFunctionData({
      abi: feedAbi,
      functionName: 'createPost',
      args: [
        {
          author: me,
          contentURI: content,
          repostedPostId: 0n,
          quotedPostId: 0n,
          repliedPostId: 0n,
          ruleChanges: [
            {
              ruleAddress: rule,
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
  };
}

describe('the calls /api/relay sponsors', () => {
  it('accepts what the app sends: posts, replies, quotes, reposts, deletes, follows and blocks', () => {
    const calls = [
      createPost(FEED, me, content),
      createPost(FEED, me, content, { kind: 'reply', postId: 1n }),
      createPost(FEED, me, content, { kind: 'quote', postId: 1n }),
      createPost(FEED, me, content, { kind: 'reply-quote', replyTo: 1n, quoteOf: 2n }),
      repost(FEED, me, 1n),
      deletePost(FEED, 1n),
      follow(GRAPH, me, them),
      unfollow(GRAPH, me, them),
      blockAccount(BLOCKING, me, them),
      unblockAccount(BLOCKING, me, them),
    ];
    for (const call of calls) {
      expect(() => assertSponsoredCall(call.target, call.data)).not.toThrow();
    }
    // Checksum casing doesn't matter.
    const post = createPost(FEED, me, content);
    expect(() =>
      assertSponsoredCall(post.target.toLowerCase() as typeof FEED, post.data)
    ).not.toThrow();
  });

  it('refuses what the SponsorRouter allows but the app never sends, like minting usernames', () => {
    refused(createAndAssignUsername(contracts.LensGlobalNamespace, me, 'freebie'));
    refused({
      target: FEED,
      data: encodeFunctionData({
        abi: feedAbi,
        functionName: 'editPost',
        args: [1n, { contentURI: content, extraData: [] }, [], [], [], []],
      }),
    });
  });

  it('refuses posts that attach rules', () => {
    refused(postWithRule(), "Parallax can't pay the fee of posts with rules");
  });

  it('refuses other targets, a function sent to the wrong target, and calldata that does not decode', () => {
    refused({ target: randomAddress(), data: createPost(FEED, me, content).data });
    refused({
      target: contracts.SponsorRouter,
      data: encodeFunctionData({
        abi: sponsorRouterAbi,
        functionName: 'execute',
        args: [me, FEED, createPost(FEED, me, content).data],
      }),
    });
    refused({ target: GRAPH, data: createPost(FEED, me, content).data });
    refused({ target: FEED, data: follow(GRAPH, me, them).data });
    refused({ target: FEED, data: '0x12345678' });
    refused({ target: FEED, data: '0x' });
    // createPost's selector with its arguments cut short.
    refused({
      target: FEED,
      data: createPost(FEED, me, content).data.slice(0, 74) as `0x${string}`,
    });
  });
});

describe('the gas cap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('defaults to 1.5M gas per relayed action and 3M per sign-up, or the env', () => {
    expect(maxGasPerTransaction()).toBe(1_500_000n);
    expect(maxGasPerSignUp()).toBe(3_000_000n);
    vi.stubEnv('SPONSOR_MAX_GAS_PER_TX', '1_000_000');
    vi.stubEnv('SPONSOR_MAX_GAS_PER_SIGNUP', '2500000');
    expect(maxGasPerTransaction()).toBe(1_000_000n);
    expect(maxGasPerSignUp()).toBe(2_500_000n);
    vi.stubEnv('SPONSOR_MAX_GAS_PER_TX', 'lots');
    expect(() => maxGasPerTransaction()).toThrow(/SPONSOR_MAX_GAS_PER_TX/);
  });

  const call = {
    address: FEED,
    abi: feedAbi,
    functionName: 'deletePost',
    args: [1n, [], []],
  } as const;

  function fakeChain(estimate: bigint) {
    vi.spyOn(publicClient, 'simulateContract').mockResolvedValue({} as never);
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(estimate);
    // Past the cap, the next step: stops the test there.
    const fees = vi
      .spyOn(publicClient, 'estimateFeesPerGas')
      .mockRejectedValue(new Error('past the cap'));
    const request = vi.spyOn(publicClient, 'request');
    return { fees, request };
  }

  it('refuses a transaction whose gas limit (estimate + 10%) is over the cap, before reserving or sending', async () => {
    const { fees, request } = fakeChain(1_400_000n);
    const usedBefore = await serverState().gasBudget.usedThisHour();
    const sent = sendAsRelayer(call, me, 1_500_000n);
    await expect(sent).rejects.toBeInstanceOf(HttpError);
    await expect(sent).rejects.toMatchObject({ status: 400 });
    expect(fees).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(await serverState().gasBudget.usedThisHour()).toBe(usedBefore);
  });

  it('lets one under the cap through', async () => {
    const { fees } = fakeChain(1_300_000n);
    await expect(sendAsRelayer(call, me, 1_500_000n)).rejects.toThrow('past the cap');
    // Fee caps at twice the base fee, so a rising base fee doesn't strand the relayer's queue.
    expect(fees).toHaveBeenCalledWith({
      chain: expect.objectContaining({ fees: expect.objectContaining({ baseFeeMultiplier: 2 }) }),
    });
  });
});
