import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import type { Address } from 'viem';
import { sessionSecret } from './env';

export type SessionData = {
  /** SIWE nonce, between /api/auth/nonce and /api/auth/verify. */
  nonce?: string;
  /** The EOA that signed in. */
  owner?: Address;
  /** The Lens Account it acts as, owned by `owner` when it was selected. */
  account?: Address;
};

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
