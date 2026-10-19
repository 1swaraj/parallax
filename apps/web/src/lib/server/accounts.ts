import type { AccountView, Page } from '@lens-monad/protocol';
import type { Address } from 'viem';
import { APP_NAME } from '../brand';
import { isOwnedBy } from './chain';
import { indexerUrl } from './env';
import { HttpError } from './guard';

const UNAVAILABLE = `${APP_NAME} can't look up your account right now. Try again in a minute.`;

/**
 * The Accounts an EOA owns. The indexer finds them, and the chain confirms each: the indexer can lag behind an
 * ownership transfer, and the session must never act for an Account its owner no longer controls.
 */
export async function accountsOwnedBy(owner: Address): Promise<Address[]> {
  // Signing in needs the indexer: unreachable or not serving yet (e.g. a new one still syncing), it's a 503 the user
  // can retry, not an internal error.
  let response: Response;
  try {
    response = await fetch(`${indexerUrl()}/accounts?owner=${owner}&limit=20`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.error('Indexer unreachable', error);
    throw new HttpError(503, UNAVAILABLE);
  }
  if (!response.ok) {
    console.error(`Indexer error ${response.status} looking up the accounts of ${owner}`);
    throw new HttpError(503, UNAVAILABLE);
  }
  const { items } = (await response.json()) as Page<AccountView>;
  const owned = await Promise.all(
    items.map(async (item) => ((await isOwnedBy(item.address, owner)) ? item.address : null))
  );
  return owned.filter((address) => address !== null);
}
