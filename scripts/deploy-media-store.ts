// Deploys MediaStore (contracts/src/MediaStore.sol) through the CREATE2 factory, at the same address on every chain,
// then lets relayers pay for images: SponsorRouter.setFunction(MediaStore, put, true), which only the router's owner
// can call.
//
//   pnpm deploy:media-store          # the local chain: deploys and allowlists (pnpm chain runs it)
//   RPC_URL=… DEPLOYER_PRIVATE_KEY=… pnpm deploy:media-store
//                                    # another chain: deploys, then prints the call the router's owner makes
//
// Then add the chain and the printed block to MEDIA_STORE_DEPLOYMENTS in packages/protocol/src/media.ts.

import {
  CREATE2_FACTORY,
  getDeployment,
  MEDIA_STORE_ADDRESS,
  MEDIA_STORE_SALT,
  mediaStoreAbi,
  sponsorRouterAbi,
} from '../packages/protocol/src';
import { MEDIA_STORE_INIT_CODE } from '../packages/protocol/src/media-store-artifact';
import {
  concat,
  createPublicClient,
  createWalletClient,
  http,
  toFunctionSelector,
  type Account,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ transport: http(RPC) });
const PUT = toFunctionSelector(mediaStoreAbi.find((item) => item.name === 'put')!);

/** Locally, anvil impersonates any address (`--auto-impersonate`); elsewhere, DEPLOYER_PRIVATE_KEY signs. */
function sender(chainId: number, local: Address): Account | Address {
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (key) {
    return privateKeyToAccount(key);
  }
  if (chainId !== 31337) {
    throw new Error(`DEPLOYER_PRIVATE_KEY is required to deploy on chain ${chainId}`);
  }
  return local;
}

async function send(from: Account | Address, to: Address, data: Hex) {
  const wallet = createWalletClient({ account: from, transport: http(RPC) });
  const hash = await wallet.sendTransaction({ to, data, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Transaction ${hash} reverted`);
  }
  return receipt;
}

async function main() {
  const chainId = await client.getChainId();
  const { contracts } = getDeployment(chainId);
  if (!(await client.getCode({ address: CREATE2_FACTORY }))) {
    throw new Error(`Chain ${chainId} has no CREATE2 factory at ${CREATE2_FACTORY}`);
  }
  if (await client.getCode({ address: MEDIA_STORE_ADDRESS })) {
    console.log(`MediaStore is already at ${MEDIA_STORE_ADDRESS} on chain ${chainId}`);
  } else {
    // Anvil's first account, the local deployer.
    const deployer = sender(chainId, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    const receipt = await send(
      deployer,
      CREATE2_FACTORY,
      concat([MEDIA_STORE_SALT, MEDIA_STORE_INIT_CODE])
    );
    if (!(await client.getCode({ address: MEDIA_STORE_ADDRESS }))) {
      throw new Error('The factory deployed nothing: is the init code the one built?');
    }
    console.log(
      `MediaStore deployed at ${MEDIA_STORE_ADDRESS} on chain ${chainId}, block ${receipt.blockNumber}`
    );
  }

  const allowed = await client.readContract({
    address: contracts.SponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'isFunctionAllowed',
    args: [MEDIA_STORE_ADDRESS, PUT],
  });
  if (allowed) {
    console.log('SponsorRouter already lets relayers pay for MediaStore.put');
  } else if (chainId === 31337) {
    // Locally, the deployer is the Safe that owns the router.
    const owner = await client.readContract({
      address: contracts.SponsorRouter,
      abi: sponsorRouterAbi,
      functionName: 'owner',
    });
    await client.request({ method: 'anvil_impersonateAccount' as never, params: [owner] as never });
    const wallet = createWalletClient({ account: owner, transport: http(RPC) });
    const hash = await wallet.writeContract({
      address: contracts.SponsorRouter,
      abi: sponsorRouterAbi,
      functionName: 'setFunction',
      args: [MEDIA_STORE_ADDRESS, PUT, true],
      chain: null,
    });
    await client.waitForTransactionReceipt({ hash });
    console.log('SponsorRouter lets relayers pay for MediaStore.put');
  } else {
    console.log(
      `Relayers can't pay for images until the SponsorRouter's owner calls\n` +
        `  ${contracts.SponsorRouter}.setFunction(${MEDIA_STORE_ADDRESS}, ${PUT}, true)\n` +
        `Until then, images are paid from the author's wallet.`
    );
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
