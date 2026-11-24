// Deploys this community's ClubForwarder: the grantee its members grant in Community Passport's grant registry.
// Does not change any shared contract or write a key to disk.
//
//   PASSPORT_GRANT_REGISTRY=0x… INSTANCE_RELAYER_ADDRESSES=0x…,0x… INSTANCE_DEPLOYER_KEYSTORE=… \
//     pnpm instance:deploy-forwarder
import { BaseError, createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { deployClubForwarder, getChain } from '../packages/protocol/src';
import { instanceSigner, relayerAddresses } from './instance-signer';

async function main() {
  const chain = getChain(Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143));
  const transport = http(process.env.RPC_URL || chain.rpcUrls.default.http[0]);
  if (!process.env.PASSPORT_GRANT_REGISTRY)
    throw new Error('Set PASSPORT_GRANT_REGISTRY to the grant registry the Passport uses');
  const registry = getAddress(process.env.PASSPORT_GRANT_REGISTRY);
  const relayers = relayerAddresses();
  const account = instanceSigner();
  const result = await deployClubForwarder({
    client: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account }),
    registry,
    relayers,
  });
  console.log(`Chain: ${chain.id}\nOwner: ${result.owner}\nRegistry: ${result.registry}`);
  console.log(`Allowlisted ${result.relayers.length} relayer(s).`);
  console.log(`Transaction: ${result.hash}\nCLUB_FORWARDER_ADDRESS=${result.forwarder}`);
  console.log(
    "Register this address as the community's grantee with the Passport, and set it in Admin → Community Passport."
  );
}
main().catch((error) => {
  // RPC and signer errors (viem's) may contain credentials, such as a provider key in the RPC URL. Print only this
  // script's own checks.
  console.error(
    error instanceof Error && !(error instanceof BaseError)
      ? `Forwarder deployment failed: ${error.message}`
      : 'Forwarder deployment failed. Check chain, signer, funding, registry and relayer addresses. If a transaction was sent, check the signer history before retrying.'
  );
  process.exitCode = 1;
});
