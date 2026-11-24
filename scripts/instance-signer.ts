// The wallet the instance scripts deploy with: INSTANCE_DEPLOYER_PRIVATE_KEY, or a Foundry keystore named by
// INSTANCE_DEPLOYER_KEYSTORE (Foundry prompts for its password, or reads INSTANCE_KEYSTORE_PASSWORD_FILE). Neither
// writes a key to disk.
import { execFileSync } from 'node:child_process';
import { getAddress, hexToSignature, keccak256, serializeTransaction, type Hex } from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';

export function instanceSigner() {
  const key = process.env.INSTANCE_DEPLOYER_PRIVATE_KEY;
  const keystore = process.env.INSTANCE_DEPLOYER_KEYSTORE;
  if (!!key === !!keystore)
    throw new Error(
      'Set exactly one of INSTANCE_DEPLOYER_PRIVATE_KEY or INSTANCE_DEPLOYER_KEYSTORE'
    );
  if (key) return privateKeyToAccount(key as Hex);
  const flags = ['--account', keystore ?? ''];
  if (process.env.INSTANCE_KEYSTORE_PASSWORD_FILE)
    flags.push('--password-file', process.env.INSTANCE_KEYSTORE_PASSWORD_FILE);
  const cast = (args: string[]) =>
    execFileSync('cast', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
  return toAccount({
    address: getAddress(cast(['wallet', 'address', ...flags])),
    async signMessage() {
      throw new Error('Only transaction signing is supported');
    },
    async signTypedData() {
      throw new Error('Only transaction signing is supported');
    },
    async signTransaction(transaction) {
      const unsigned = serializeTransaction(transaction);
      const signature = hexToSignature(
        cast(['wallet', 'sign', '--no-hash', keccak256(unsigned), ...flags]) as Hex
      );
      return serializeTransaction(transaction, signature);
    },
  });
}

/** INSTANCE_RELAYER_ADDRESSES: the instance's relayer addresses, comma-separated. */
export function relayerAddresses() {
  const addresses = (process.env.INSTANCE_RELAYER_ADDRESSES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => getAddress(a));
  if (!addresses.length)
    throw new Error('Set INSTANCE_RELAYER_ADDRESSES to comma-separated public relayer addresses');
  return addresses;
}
