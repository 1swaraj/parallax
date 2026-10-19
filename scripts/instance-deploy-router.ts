// Deploys only the caller's instance router. Does not change any shared contract or write a key to disk.
import { execFileSync } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  hexToSignature,
  http,
  keccak256,
  serializeTransaction,
  type Hex,
} from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';
import { deployInstanceRouter, getChain, getDeployment } from '../packages/protocol/src';

async function main() {
  const chain = getChain(Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143));
  const transport = http(process.env.RPC_URL || chain.rpcUrls.default.http[0]);
  const addresses = (process.env.INSTANCE_RELAYER_ADDRESSES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => getAddress(a));
  if (!addresses.length)
    throw new Error('Set INSTANCE_RELAYER_ADDRESSES to comma-separated public relayer addresses');
  const key = process.env.INSTANCE_DEPLOYER_PRIVATE_KEY;
  const keystore = process.env.INSTANCE_DEPLOYER_KEYSTORE;
  if (!!key === !!keystore)
    throw new Error(
      'Set exactly one of INSTANCE_DEPLOYER_PRIVATE_KEY or INSTANCE_DEPLOYER_KEYSTORE'
    );
  const flags = ['--account', keystore ?? ''];
  if (process.env.INSTANCE_KEYSTORE_PASSWORD_FILE)
    flags.push('--password-file', process.env.INSTANCE_KEYSTORE_PASSWORD_FILE);
  const cast = (args: string[]) =>
    execFileSync('cast', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
  const account = key
    ? privateKeyToAccount(key as Hex)
    : toAccount({
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
  const result = await deployInstanceRouter({
    client: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account }),
    referenceRouter: getDeployment(chain.id).contracts.SponsorRouter,
    relayers: addresses,
  });
  console.log(
    `Chain: ${chain.id}\nOwner: ${result.owner}\nImplementation: ${result.implementation}`
  );
  console.log(
    `Copied ${result.functions.length} functions; allowlisted ${result.relayers.length} relayer(s).`
  );
  console.log(`Transaction: ${result.hash}\nSPONSOR_ROUTER_ADDRESS=${result.router}`);
  console.log('Use this router in the instance admin config. Fund the relayers separately.');
}
main().catch(() => {
  // RPC and signer errors may contain credentials. Do not print their raw request data.
  console.error(
    'Router deployment failed. Check chain, signer, funding and relayer addresses. If a transaction was sent, check the signer history before retrying.'
  );
  process.exitCode = 1;
});
