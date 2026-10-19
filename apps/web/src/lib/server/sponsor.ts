import {
  accountBlockingRuleAbi,
  feedAbi,
  graphAbi,
  MAX_IMAGE_BYTES,
  MEDIA_CHUNK_BYTES,
  mediaStoreAbi,
  readPostImage,
  sponsorRouterAbi,
} from '@lens-monad/protocol';
import {
  decodeFunctionData,
  isAddressEqual,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { currentConfig } from '@/lib/server/instance-config';
import { mediaStore } from '../config';
import { runtimeContracts as contracts } from './contracts';
import { isOwnedBy, isSponsored, publicClient } from './chain';
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
      `This account doesn't let ${currentConfig().appName} pay its fees. Allow it in Settings.`
    );
  }
  await rateLimit(`relay:${account}`, numberEnv('RELAY_RATE_LIMIT_PER_MINUTE', 30), 60 * 1000);
  return account;
}

/**
 * The calls the app's client relays (@lens-monad/protocol's calls.ts and media.ts): posts, replies, quotes and
 * reposts, deleting them, follows, blocks, and the chunks of post images. The SponsorRouter allows more, e.g.
 * Namespace.createAndAssignUsername and Feed.editPost, which would let anyone spend the relayers' gas on what the app
 * never sends, like minting usernames.
 */
const SPONSORED_CALLS: { target: Address; abi: Abi; functionNames: string[] }[] = [
  { target: contracts.LensGlobalFeed, abi: feedAbi, functionNames: ['createPost', 'deletePost'] },
  { target: contracts.LensGlobalGraph, abi: graphAbi, functionNames: ['follow', 'unfollow'] },
  {
    target: contracts.AccountBlockingRule,
    abi: accountBlockingRuleAbi,
    functionNames: ['blockUser', 'unblockUser'],
  },
  ...(mediaStore
    ? [{ target: mediaStore.address, abi: mediaStoreAbi, functionNames: ['put'] }]
    : []),
];

function decode(abi: Abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

/**
 * What a sponsored call is, for the gas limit the relayer allows it: posts with an image store bigger metadata, and
 * chunks of images are mostly calldata.
 */
export type SponsoredCallKind = 'action' | 'image-post' | 'media-chunk';

/**
 * Refuses (400) a call to /api/relay that isn't one of SPONSORED_CALLS, that adds rules, or that stores more of an
 * image than the app posts. Otherwise says what kind of call it is.
 */
export function assertSponsoredCall(target: Address, data: Hex): SponsoredCallKind {
  const allowed = SPONSORED_CALLS.find((entry) => isAddressEqual(entry.target, target));
  const call = allowed ? decode(allowed.abi, data) : null;
  if (!allowed || !call || !allowed.functionNames.includes(call.functionName)) {
    throw new HttpError(400, `${currentConfig().appName} can't pay the fee of that action`);
  }
  // Rule changes attach contracts of the caller's choosing to the post, which run on the relayer's gas. No other
  // sponsored function changes rules.
  if (call.functionName === 'createPost') {
    const [post] = call.args as readonly [{ ruleChanges: readonly unknown[]; contentURI: string }];
    if (post.ruleChanges.length > 0) {
      throw new HttpError(400, `${currentConfig().appName} can't pay the fee of posts with rules`);
    }
    return readPostImage(post.contentURI) ? 'image-post' : 'action';
  }
  // The app's images: chunks of at most MEDIA_CHUNK_BYTES, within the first MAX_IMAGE_BYTES of a media.
  if (call.functionName === 'put') {
    const [, offset, data] = call.args as readonly [Hex, bigint, Hex];
    const size = (data.length - 2) / 2;
    if (size === 0 || size > MEDIA_CHUNK_BYTES || offset + BigInt(size) > BigInt(MAX_IMAGE_BYTES)) {
      throw new HttpError(400, `${currentConfig().appName} can't pay the fee of an image that big`);
    }
    return 'media-chunk';
  }
  return 'action';
}

/** Whether a call is a chunk of an image, which /api/relay caps differently. */
export function isMediaCall(target: Address) {
  return mediaStore !== null && isAddressEqual(target, mediaStore.address);
}

const PUT = toFunctionSelector(mediaStoreAbi.find((item) => item.name === 'put')!);

/**
 * The SponsorRouter only executes the functions its owner (the Safe) allowed. Until it allows MediaStore.put, images
 * are paid from the author's wallet; this says so, rather than the router's NotAllowed.
 */
export async function assertMediaSponsored() {
  const allowed = await publicClient.readContract({
    address: contracts.SponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'isFunctionAllowed',
    args: [mediaStore!.address, PUT],
  });
  if (!allowed) {
    throw new HttpError(
      403,
      `${currentConfig().appName} doesn't pay for images yet. Pay the fee from your wallet (Settings) to post one.`
    );
  }
}
