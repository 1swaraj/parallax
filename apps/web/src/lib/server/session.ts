import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import type { Address } from 'viem';
import { sessionSecret } from './env';

export type SessionData = {
  /** SIWE nonce, between /api/auth/nonce and /api/auth/verify. */
  nonce?: string;
  /** When the nonce was issued (ms): it expires after NONCE_TTL_MS. */
  nonceAt?: number;
  /** The EOA that signed in. */
  owner?: Address;
  /** The Lens Account it acts as, owned by `owner` when it was selected. */
  account?: Address;
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
