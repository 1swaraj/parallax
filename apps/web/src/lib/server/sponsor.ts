import type { Address } from 'viem';
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
