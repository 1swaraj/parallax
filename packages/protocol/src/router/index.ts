import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { sponsorRouterAbi } from '../abis';
import artifact from './artifact.json';

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const TESTNET_IMPLEMENTATION_HASH =
  '0x776bf070365ad51a4e9321c1de566d48dfcdeba8aac098c7e6ea5fb8bf4eb807';

/** Deploys an immutable proxy with initialize in its constructor, so nobody can claim it between transactions. */
export async function deployInstanceRouter({
  client,
  wallet,
  referenceRouter,
  relayers,
}: {
  client: PublicClient;
  wallet: WalletClient;
  referenceRouter: Address;
  relayers: Address[];
}) {
  if (!wallet.account || !wallet.chain) throw new Error('A signing account and chain are required');
  const owner = wallet.account.address;
  const chainId = await client.getChainId();
  if (chainId !== wallet.chain.id)
    throw new Error('RPC chain ID does not match the selected chain');
  if (!relayers.length || relayers.some((address) => isAddressEqual(address, zeroAddress))) {
    throw new Error('At least one nonzero relayer address is required');
  }
  if (new Set(relayers.map((address) => address.toLowerCase())).size !== relayers.length) {
    throw new Error('A relayer address is listed twice');
  }
  const slot = await client.getStorageAt({ address: referenceRouter, slot: IMPLEMENTATION_SLOT });
  if (!slot || BigInt(slot) === 0n)
    throw new Error('Reference router has no EIP-1967 implementation');
  const implementation = getAddress(`0x${slot.slice(-40)}`);
  const code = await client.getCode({ address: implementation });
  if (!code || code === '0x') throw new Error('Router implementation has no code');
  if (chainId === 10143 && keccak256(code) !== TESTNET_IMPLEMENTATION_HASH) {
    throw new Error('Testnet router implementation changed; review the new code before deploying');
  }
  const functions = await client.readContract({
    address: referenceRouter,
    abi: sponsorRouterAbi,
    functionName: 'getFunctions',
  });
  if (!functions.length) throw new Error('Reference function allowlist is empty');
  const initialization = encodeFunctionData({
    abi: sponsorRouterAbi,
    functionName: 'initialize',
    args: [owner, relayers, functions],
  });
  const parameters = {
    account: wallet.account,
    chain: wallet.chain,
    abi: parseAbi(['constructor(address routerImplementation, bytes initialization)']),
    bytecode: artifact.bytecode as Hex,
    args: [implementation, initialization],
  } as const;
  // Monad charges the gas limit. Estimate and add the same 10% margin used by the web relayer.
  // https://docs.monad.xyz/developer-essentials/gas-pricing
  const gas =
    ((await client.estimateGas({ account: owner, data: encodeDeployData(parameters) })) * 110n) /
    100n;
  const hash = await wallet.deployContract({ ...parameters, gas });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress)
    throw new Error(`Router deployment failed: ${hash}`);
  const router = receipt.contractAddress;
  const actualOwner = await client.readContract({
    address: router,
    abi: sponsorRouterAbi,
    functionName: 'owner',
  });
  const actualFunctions = await client.readContract({
    address: router,
    abi: sponsorRouterAbi,
    functionName: 'getFunctions',
  });
  const actualRelayers = await client.readContract({
    address: router,
    abi: sponsorRouterAbi,
    functionName: 'getRelayers',
  });
  if (
    !isAddressEqual(actualOwner, owner) ||
    actualFunctions.length !== functions.length ||
    actualRelayers.length !== relayers.length
  ) {
    throw new Error(`Router ${router} was deployed, but configuration verification failed`);
  }
  for (const entry of functions) {
    if (
      !actualFunctions.some(
        (f) => isAddressEqual(f.target, entry.target) && f.selector === entry.selector
      )
    ) {
      throw new Error(`Router ${router} function verification failed`);
    }
  }
  for (const relayer of relayers) {
    if (!actualRelayers.some((address) => isAddressEqual(address, relayer))) {
      throw new Error(`Router ${router} relayer verification failed`);
    }
  }
  return { router, owner, implementation, hash, functions, relayers };
}
