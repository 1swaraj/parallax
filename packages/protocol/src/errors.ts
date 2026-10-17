import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from 'viem';
import {
  accountAbi,
  accountBlockingRuleAbi,
  accountFactoryAbi,
  feedAbi,
  graphAbi,
  lensFactoryAbi,
  namespaceAbi,
  sponsorRouterAbi,
} from './abis';

/**
 * Every custom error the synced contracts declare. Errors bubble up through the Account and the SponsorRouter, so a
 * revert from the Feed has to be decoded with the Feed's errors even when the router was called.
 */
export const lensErrorsAbi: Abi = (() => {
  const seen = new Set<string>();
  const errors = [];
  const abis: readonly Abi[] = [
    accountAbi,
    accountBlockingRuleAbi,
    accountFactoryAbi,
    feedAbi,
    graphAbi,
    lensFactoryAbi,
    namespaceAbi,
    sponsorRouterAbi,
  ];
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type === 'error') {
        const signature = `${item.name}(${item.inputs.map((input) => input.type).join(',')})`;
        if (!seen.has(signature)) {
          seen.add(signature);
          errors.push(item);
        }
      }
    }
  }
  return errors;
})();

const MESSAGES: Record<string, string> = {
  AccessDenied: "This account isn't allowed to do that.",
  ActionOnSelf: "You can't do that to yourself.",
  AlreadyExists: 'That already exists, e.g. the username is taken.',
  Blocked: 'This account blocked you.',
  CannotFollowAgain: 'You already follow this account.',
  NotFollowing: "You don't follow this account.",
  CannotStartWithThat: 'Usernames start with a lowercase letter or a digit.',
  DoesNotExist: "That doesn't exist anymore.",
  InvalidMsgSender: "This account can't act for another one.",
  NotAllowed: "That isn't allowed.",
  NotAContract: "That address isn't a Lens Account.",
  RedundantStateChange: 'Nothing to change: it was already done.',
  UsernameAssigned: 'That username is already taken.',
  Expired: 'The request expired, try again.',
  RequiredRuleReverted: 'A rule of this feed, post or account rejected it.',
  AllAnyOfRulesReverted: 'A rule of this feed, post or account rejected it.',
};

function errorName(data: Hex | undefined): string | null {
  if (!data || data.length < 10) {
    return null;
  }
  try {
    return decodeErrorResult({ abi: lensErrorsAbi, data }).errorName;
  } catch {
    return null;
  }
}

/** The name of the Lens custom error behind a viem error, when there is one. */
export function lensErrorName(error: unknown): string | null {
  if (!(error instanceof BaseError)) {
    return null;
  }
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? errorName(reverted.raw);
  }
  // Raw revert data, e.g. from a transaction simulated without the target's ABI.
  const withData = error.walk((cause) => typeof (cause as { data?: unknown }).data === 'string');
  return errorName((withData as { data?: Hex } | null)?.data);
}

/** A short message for users. */
export function describeLensError(error: unknown): string {
  const name = lensErrorName(error);
  if (name) {
    return MESSAGES[name] ?? `The transaction was rejected (${name}).`;
  }
  if (error instanceof BaseError) {
    if (error.walk((cause) => (cause as { name?: string }).name === 'UserRejectedRequestError')) {
      return 'You rejected the request in your wallet.';
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
