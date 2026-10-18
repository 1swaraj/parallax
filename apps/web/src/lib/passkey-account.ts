// Loaded only once a passkey prompt is open (lib/passkey.ts): the key derivation and signing code stay out of the
// page for everyone who doesn't use a passkey.
import { createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { LocalAccount } from 'viem';

/**
 * Parallax's derivation, the one mera's getting-started guide shows: the PRF output as BIP-39 entropy, then BIP-44's
 * first Ethereum account. Another derivation gives other accounts from the same passkey, so this can't change.
 */
const ACCOUNT_PATH = "m/44'/60'/0'/0/0";

/** The account a PRF output derives, in a mera signing session that holds its key until `end()`. */
export function unlockAccount(prfOutput: Uint8Array): { account: LocalAccount; end: () => void } {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH);
  seed.fill(0);
  prfOutput.fill(0);
  if (!node.privateKey) {
    throw new Error("This passkey didn't produce an account");
  }
  const session = createSecp256k1SigningSession({ privateKey: node.privateKey });
  node.wipePrivateData();
  return { account: toViemAccount(session), end: () => session.end() };
}
