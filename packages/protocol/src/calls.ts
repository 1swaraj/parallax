import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import {
  accountAbi,
  accountBlockingRuleAbi,
  feedAbi,
  graphAbi,
  lensFactoryAbi,
  namespaceAbi,
} from './abis';

/**
 * A call a Lens Account makes. The Account is msg.sender, so the primitives treat it as the author, follower or
 * blocker: an Account can only act for itself, whoever relays the call.
 *
 * It's sent either sponsored, through SponsorRouter.execute(account, target, data) by a relayer, or directly, through
 * Account.executeTransaction(target, 0, data) by the Account's owner.
 */
export type AccountCall = { target: Address; data: Hex };

export type PostReference =
  | { kind: 'post' }
  | { kind: 'reply'; postId: bigint }
  | { kind: 'quote'; postId: bigint }
  | { kind: 'reply-quote'; replyTo: bigint; quoteOf: bigint };

export function createPost(
  feed: Address,
  author: Address,
  contentURI: string,
  reference: PostReference = { kind: 'post' }
): AccountCall {
  const repliedPostId =
    reference.kind === 'reply'
      ? reference.postId
      : reference.kind === 'reply-quote'
        ? reference.replyTo
        : 0n;
  const quotedPostId =
    reference.kind === 'quote'
      ? reference.postId
      : reference.kind === 'reply-quote'
        ? reference.quoteOf
        : 0n;
  return {
    target: feed,
    data: encodeFunctionData({
      abi: feedAbi,
      functionName: 'createPost',
      args: [
        {
          author,
          contentURI,
          repostedPostId: 0n,
          quotedPostId,
          repliedPostId,
          ruleChanges: [],
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

/** Reposts carry no content: FeedCore requires an empty contentURI, and no reply or quote. */
export function repost(feed: Address, author: Address, postId: bigint): AccountCall {
  return {
    target: feed,
    data: encodeFunctionData({
      abi: feedAbi,
      functionName: 'createPost',
      args: [
        {
          author,
          contentURI: '',
          repostedPostId: postId,
          quotedPostId: 0n,
          repliedPostId: 0n,
          ruleChanges: [],
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

export function deletePost(feed: Address, postId: bigint): AccountCall {
  return {
    target: feed,
    data: encodeFunctionData({ abi: feedAbi, functionName: 'deletePost', args: [postId, [], []] }),
  };
}

export function follow(graph: Address, follower: Address, target: Address): AccountCall {
  return {
    target: graph,
    data: encodeFunctionData({
      abi: graphAbi,
      functionName: 'follow',
      args: [follower, target, [], [], [], []],
    }),
  };
}

export function unfollow(graph: Address, follower: Address, target: Address): AccountCall {
  return {
    target: graph,
    data: encodeFunctionData({
      abi: graphAbi,
      functionName: 'unfollow',
      args: [follower, target, [], []],
    }),
  };
}

export function blockAccount(rule: Address, blocker: Address, blocked: Address): AccountCall {
  return {
    target: rule,
    data: encodeFunctionData({
      abi: accountBlockingRuleAbi,
      functionName: 'blockUser',
      args: [blocker, blocked],
    }),
  };
}

export function unblockAccount(rule: Address, blocker: Address, blocked: Address): AccountCall {
  return {
    target: rule,
    data: encodeFunctionData({
      abi: accountBlockingRuleAbi,
      functionName: 'unblockUser',
      args: [blocker, blocked],
    }),
  };
}

/** Claims a free username in a Namespace for an Account that has none yet. */
export function createAndAssignUsername(
  namespace: Address,
  account: Address,
  username: string
): AccountCall {
  return {
    target: namespace,
    data: encodeFunctionData({
      abi: namespaceAbi,
      functionName: 'createAndAssignUsername',
      args: [account, username, [], [], [], [], []],
    }),
  };
}

/** The data the Account's owner sends to the Account to make the call directly. */
export function directExecution(call: AccountCall): Hex {
  return encodeFunctionData({
    abi: accountAbi,
    functionName: 'executeTransaction',
    args: [call.target, 0n, call.data],
  });
}

/**
 * The permissions SponsorRouter is meant to get (see its NatSpec): executing transactions and setting the metadata,
 * nothing that moves tokens.
 */
export const SPONSOR_ROUTER_PERMISSIONS = {
  canExecuteTransactions: true,
  canTransferTokens: false,
  canTransferNative: false,
  canSetMetadataURI: true,
} as const;

/** No app's source stamp: e.g. Account.setMetadataURI then sets the Account's default metadata, not an app's. */
export const EMPTY_SOURCE_STAMP = {
  source: zeroAddress,
  originalMsgSender: zeroAddress,
  validator: zeroAddress,
  nonce: 0n,
  deadline: 0n,
  signature: '0x',
} as const;

/**
 * Arguments of LensFactory.createAccountWithUsernameFree: an Account owned by `owner`, with SponsorRouter as its
 * manager (so relayers can act for it) and `username` in `namespace`. Anyone can send it, so a relayer can pay for it.
 */
export function createAccountWithUsernameArgs(params: {
  namespace: Address;
  owner: Address;
  username: string;
  metadataURI: string;
  sponsorRouter: Address | null;
}) {
  return [
    params.namespace,
    {
      metadataURI: params.metadataURI,
      owner: params.owner,
      accountManagers: params.sponsorRouter ? [params.sponsorRouter] : [],
      accountManagersPermissions: params.sponsorRouter ? [SPONSOR_ROUTER_PERMISSIONS] : [],
      accountCreationSourceStamp: EMPTY_SOURCE_STAMP,
      accountExtraData: [],
    },
    {
      username: params.username,
      createUsernameCustomParams: [],
      createUsernameRuleProcessingParams: [],
      assignUsernameCustomParams: [],
      assignRuleProcessingParams: [],
      usernameExtraData: [],
    },
  ] as const;
}

/** Calldata of LensFactory.createAccountWithUsernameFree, for the owner sending it directly from their wallet. */
export function createAccountWithUsername(
  lensFactory: Address,
  params: Parameters<typeof createAccountWithUsernameArgs>[0]
): AccountCall {
  return {
    target: lensFactory,
    data: encodeFunctionData({
      abi: lensFactoryAbi,
      functionName: 'createAccountWithUsernameFree',
      args: createAccountWithUsernameArgs(params),
    }),
  };
}
