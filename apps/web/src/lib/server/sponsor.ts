import { accountBlockingRuleAbi, feedAbi, graphAbi } from '@lens-monad/protocol';
import { decodeFunctionData, isAddressEqual, type Abi, type Address, type Hex } from 'viem';
import { contracts } from '../config';
import { isOwnedBy, isSponsored } from './chain';
import { numberEnv } from './env';
import { HttpError } from './guard';
import type { SessionData } from './session';
import { rateLimit } from './state';

/**
 * The Account a sponsored request acts for: the session's, confirmed on-chain to still belong to the EOA that signed
 * in, and to have the SponsorRouter as manager. Rate-limited per Account.
 */
export async function sponsoredAccount(session: SessionData): Promise<Address> {
  const { owner, account } = session;
  if (!owner || !account) {
    throw new HttpError(401, 'Sign in with a Lens account first');
  }
  if (!(await isOwnedBy(account, owner))) {
    throw new HttpError(403, 'Your wallet no longer owns this account, sign in again');
  }
  if (!(await isSponsored(account))) {
    throw new HttpError(
      403,
      "This account doesn't allow sponsored actions, enable them in Settings"
    );
  }
  await rateLimit(`relay:${account}`, numberEnv('RELAY_RATE_LIMIT_PER_MINUTE', 30), 60 * 1000);
  return account;
}

/**
 * The calls the app's client relays (@lens-monad/protocol's calls.ts): posts, replies, quotes and reposts, deleting
 * them, follows and blocks. The SponsorRouter allows more, e.g. Namespace.createAndAssignUsername and Feed.editPost,
 * which would let anyone spend the relayers' gas on what the app never sends, like minting usernames.
 */
const SPONSORED_CALLS: { target: Address; abi: Abi; functionNames: string[] }[] = [
  { target: contracts.LensGlobalFeed, abi: feedAbi, functionNames: ['createPost', 'deletePost'] },
  { target: contracts.LensGlobalGraph, abi: graphAbi, functionNames: ['follow', 'unfollow'] },
  {
    target: contracts.AccountBlockingRule,
    abi: accountBlockingRuleAbi,
    functionNames: ['blockUser', 'unblockUser'],
  },
];

function decode(abi: Abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

/** Refuses (400) a call to /api/relay that isn't one of SPONSORED_CALLS, or that adds rules. */
export function assertSponsoredCall(target: Address, data: Hex) {
  const allowed = SPONSORED_CALLS.find((entry) => isAddressEqual(entry.target, target));
  const call = allowed ? decode(allowed.abi, data) : null;
  if (!allowed || !call || !allowed.functionNames.includes(call.functionName)) {
    throw new HttpError(400, "That action can't be sponsored");
  }
  // Rule changes attach contracts of the caller's choosing to the post, which run on the relayer's gas. No other
  // sponsored function changes rules.
  if (call.functionName === 'createPost') {
    const [post] = call.args as readonly [{ ruleChanges: readonly unknown[] }];
    if (post.ruleChanges.length > 0) {
      throw new HttpError(400, "Posts with rules can't be sponsored");
    }
  }
}
