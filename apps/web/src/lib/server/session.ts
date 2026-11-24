import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import type { Address } from 'viem';
import { sessionSecret } from './env';
import type { PendingPassportSignIn } from './passport';

export type SessionData = {
  /** SIWE nonce, between /api/auth/nonce and /api/auth/verify. */
  nonce?: string;
  /** When the nonce was issued (ms): it expires after NONCE_TTL_MS. */
  nonceAt?: number;
  /** The EOA that signed in. Unset for a Community Passport session: no wallet signed in. */
  owner?: Address;
  /** The Lens Account it acts as, owned by `owner` when it was selected, or the one the Passport signed in. */
  account?: Address;
  /** How the session signed in: a wallet (SIWE, the default) or Community Passport. */
  via?: 'passport';
  /**
   * For a Passport session, the Account's owner on-chain when it signed in (the Passport's key, or the member's own
   * after they take it). Moderation knows members by an owner: allowlists, suspensions and token gates use this one.
   */
  holder?: Address;
  /** A Passport sign-in under way, between /api/auth/passport and its callback. */
  passport?: PendingPassportSignIn;
};

/** How long a SIWE nonce, and the message signed with it, stay good. */
export const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Whether a sign-in is recent: its nonce issued in the last NONCE_TTL_MS, and its message too (give or take a minute
 * of the wallet's clock), so a signature obtained earlier can't be used later.
 */
export function isFreshSignIn(
  nonceAt: number | undefined,
  issuedAt: Date | undefined,
  now = Date.now()
): boolean {
  const issued = issuedAt?.getTime();
  return (
    nonceAt !== undefined &&
    now - nonceAt <= NONCE_TTL_MS &&
    issued !== undefined &&
    !Number.isNaN(issued) &&
    now - issued <= NONCE_TTL_MS &&
    issued - now <= MAX_CLOCK_SKEW_MS
  );
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), {
    password: sessionSecret(),
    cookieName: 'lens_session',
    ttl: 7 * 24 * 60 * 60,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    },
  });
}
