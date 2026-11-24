import { grantRegistryAbi } from '@lens-monad/protocol';
import { BaseError, ContractFunctionRevertedError, slice, type Address, type Hex } from 'viem';
import { isOwnedBy, publicClient } from './chain';
import { currentConfig } from './instance-config';
import { HttpError } from './guard';
import { passportSettings, type PassportSettings } from './passport';
import type { SessionData } from './session';

export type Member = {
  account: Address;
  /** The owner moderation knows the member by: the wallet that signed in, or a Passport member's `holder`. */
  owner: Address;
  /** Set for a Community Passport session. */
  passport: PassportSettings | null;
};

/** Sent with the errors that mean "go back through Community Passport": the client restarts its sign-in. */
const REAUTH = { reauth: true };

/**
 * The member a request acts for, checked on-chain.
 *
 * - A wallet session (SIWE): the wallet that signed in must still own the Account.
 * - A Community Passport session: no wallet signed in. This community's grant on the Account must still be live, so a
 *   member who disconnects the community in the Passport, or whose grant runs out, is signed out here too.
 */
export async function signedInMember(
  session: SessionData,
  message = 'Sign in with a Lens account first'
): Promise<Member> {
  const { owner, account } = session;
  if (session.via === 'passport') {
    if (!account || !session.holder) throw new HttpError(401, message);
    const passport = await passportSettings();
    if (!passport) {
      throw new HttpError(
        401,
        'Community Passport sign-in is no longer set up here. Sign in again.'
      );
    }
    if (!(await hasLiveGrant(passport, account))) {
      throw new HttpError(
        401,
        `${currentConfig().appName} is no longer connected to your account. Sign in again to reconnect it.`,
        REAUTH
      );
    }
    return { account, owner: session.holder, passport };
  }
  if (!owner || !account) throw new HttpError(401, message);
  if (!(await isOwnedBy(account, owner))) {
    throw new HttpError(403, 'Your wallet no longer owns this account, sign in again');
  }
  return { account, owner, passport: null };
}

/** Whether this community holds a grant on the Account that hasn't ended or run out. */
export async function hasLiveGrant(passport: PassportSettings, account: Address) {
  const [, expiry] = await publicClient.readContract({
    address: passport.registry,
    abi: grantRegistryAbi,
    functionName: 'grantOf',
    args: [account, passport.forwarder],
  });
  return expiry > BigInt(Math.floor(Date.now() / 1000));
}

/** Whether the member's grant lets this community make that call: its contract and function are in the grant. */
export async function isGranted(
  passport: PassportSettings,
  account: Address,
  target: Address,
  data: Hex
) {
  if (data.length < 10) return false;
  return publicClient.readContract({
    address: passport.registry,
    abi: grantRegistryAbi,
    functionName: 'isAllowed',
    args: [account, passport.forwarder, target, slice(data, 0, 4)],
  });
}

/**
 * What a reverted call through the ClubForwarder means for the member, or null when it isn't the registry's or the
 * forwarder's doing (a Lens error is described as for any relayed call).
 */
export function passportRevert(error: unknown): HttpError | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  const name =
    reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
  const appName = currentConfig().appName;
  switch (name) {
    case 'GrantNotActive':
      return new HttpError(
        401,
        `${appName} is no longer connected to your account. Sign in again to reconnect it.`,
        REAUTH
      );
    case 'NotInScope':
      return new HttpError(
        403,
        `Your connection to ${appName} doesn't cover this. Sign in again to review what it can do.`,
        REAUTH
      );
    case 'RegistryPaused':
      return new HttpError(
        503,
        'Community Passport has paused apps acting for members. Try again later.'
      );
    case 'NotRelayer':
      console.error("A relayer key isn't allowlisted on this community's ClubForwarder");
      return new HttpError(503, `${appName} can't act for you right now. Try again soon.`);
    default:
      return null;
  }
}
