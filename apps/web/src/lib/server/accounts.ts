import type { AccountView, Page } from '@lens-monad/protocol';
import type { Address } from 'viem';
import { isOwnedBy } from './chain';
import { indexerUrl } from './env';

/**
 * The Accounts an EOA owns. The indexer finds them, and the chain confirms each: the indexer can lag behind an
 * ownership transfer, and the session must never act for an Account its owner no longer controls.
 */
export async function accountsOwnedBy(owner: Address): Promise<Address[]> {
  const response = await fetch(`${indexerUrl()}/accounts?owner=${owner}&limit=20`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Indexer error ${response.status}`);
  }
  const { items } = (await response.json()) as Page<AccountView>;
  const owned = await Promise.all(
    items.map(async (item) => ((await isOwnedBy(item.address, owner)) ? item.address : null))
  );
  return owned.filter((address) => address !== null);
}
