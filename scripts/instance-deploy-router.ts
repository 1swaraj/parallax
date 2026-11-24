// Deploys only the caller's instance router. Does not change any shared contract or write a key to disk.
import { createPublicClient, createWalletClient, http } from 'viem';
import { deployInstanceRouter, getChain, getDeployment } from '../packages/protocol/src';
import { instanceSigner, relayerAddresses } from './instance-signer';

async function main() {
  const chain = getChain(Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143));
  const transport = http(process.env.RPC_URL || chain.rpcUrls.default.http[0]);
  const addresses = relayerAddresses();
  const account = instanceSigner();
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
