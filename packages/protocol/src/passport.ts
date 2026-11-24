import {
  encodeDeployData,
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { CLUB_FORWARDER_BYTECODE, clubForwarderAbi } from './club-forwarder-artifact';

export { clubForwarderAbi };

/**
 * What the app reads from Community Passport's grant registry (github.com/bensprks/community-passport,
 * IGrantRegistry.sol), and the errors its `execute` reverts with, which come back through a ClubForwarder unchanged.
 */
export const grantRegistryAbi = parseAbi([
  'function grantOf(address account, address grantee) view returns (bytes32 scopeId, uint64 expiry)',
  'function isAllowed(address account, address grantee, address target, bytes4 selector) view returns (bool)',
  'function paused() view returns (bool)',
  'error GrantNotActive()',
  'error NotInScope()',
  'error RegistryPaused()',
]);

/** ClubForwarder.execute, with the registry's errors, so that a reverted call says which one it was. */
export const passportRelayAbi = [
  ...clubForwarderAbi,
  ...grantRegistryAbi.filter((item) => item.type === 'error'),
] as const;

/**
 * Deploys a community's ClubForwarder: the grantee its members grant in Community Passport's registry. The deploying
 * wallet owns it and decides who relays. Hand it to the community with transferOwnership, then acceptOwnership from
 * their wallet: the relayer list and every member's grant stay as they are.
 */
export async function deployClubForwarder({
  client,
  wallet,
  registry,
  relayers,
}: {
  client: PublicClient;
  wallet: WalletClient;
  registry: Address;
  relayers: Address[];
}) {
  if (!wallet.account || !wallet.chain) throw new Error('A signing account and chain are required');
  const owner = wallet.account.address;
  if ((await client.getChainId()) !== wallet.chain.id)
    throw new Error('RPC chain ID does not match the selected chain');
  if (!relayers.length || relayers.some((address) => isAddressEqual(address, zeroAddress))) {
    throw new Error('At least one nonzero relayer address is required');
  }
  if (new Set(relayers.map((address) => address.toLowerCase())).size !== relayers.length) {
    throw new Error('A relayer address is listed twice');
  }
  const code = await client.getCode({ address: registry });
  if (!code || code === '0x') throw new Error('The grant registry address has no code');
  const parameters = {
    account: wallet.account,
    chain: wallet.chain,
    abi: clubForwarderAbi,
    bytecode: CLUB_FORWARDER_BYTECODE,
    args: [registry, owner, relayers],
  } as const;
  // Monad charges the gas limit. Estimate and add the same 10% margin used by the web relayer.
  // https://docs.monad.xyz/developer-essentials/gas-pricing
  const gas =
    ((await client.estimateGas({ account: owner, data: encodeDeployData(parameters) })) * 110n) /
    100n;
  const hash = await wallet.deployContract({ ...parameters, gas });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress)
    throw new Error(`Forwarder deployment failed: ${hash}`);
  const forwarder = getAddress(receipt.contractAddress);
  const read = <name extends 'owner' | 'registry'>(functionName: name) =>
    client.readContract({ address: forwarder, abi: clubForwarderAbi, functionName });
  const [actualOwner, actualRegistry] = await Promise.all([read('owner'), read('registry')]);
  const allowed = await Promise.all(
    relayers.map((relayer) =>
      client.readContract({
        address: forwarder,
        abi: clubForwarderAbi,
        functionName: 'isRelayer',
        args: [relayer],
      })
    )
  );
  if (
    !isAddressEqual(actualOwner, owner) ||
    !isAddressEqual(actualRegistry, registry) ||
    allowed.includes(false)
  ) {
    throw new Error(`Forwarder ${forwarder} was deployed, but configuration verification failed`);
  }
  return { forwarder, owner, registry, relayers, hash };
}
