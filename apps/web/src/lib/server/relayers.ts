import { hexToBigInt, keccak256, type Address } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { relayerKeys } from './env';

let accounts: PrivateKeyAccount[] | undefined;

/** The relayers, in RELAYER_PRIVATE_KEYS order. */
export function relayers(): PrivateKeyAccount[] {
  accounts ??= relayerKeys().map((key) => privateKeyToAccount(key));
  return accounts;
}

/**
 * Which of `count` relayers sends for `actor`: a hash of the address's bytes (so checksum casing doesn't matter), the
 * same on every instance.
 */
export function relayerIndex(actor: Address, count: number): number {
  return Number(hexToBigInt(keccak256(actor)) % BigInt(count));
}

/**
 * The relayer that sends for a Lens Account (or, for sign-ups, the owner). Always the same one, so an Account's
 * actions go out in order, from one nonce sequence.
 */
export function relayerFor(actor: Address): PrivateKeyAccount {
  const all = relayers();
  return all[relayerIndex(actor, all.length)]!;
}
