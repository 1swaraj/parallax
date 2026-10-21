import { accountAbi, gasLimit, lensErrorName, sponsorRouterAbi } from '@lens-monad/protocol';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddressEqual,
  keccak256,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { currentConfig } from './instance-config';
import { chain, IS_LOCAL } from '../config';
import { getSponsorshipConfig } from './sponsorship-config';
import { serverRpcUrl } from './env';
import { HttpError } from './guard';
import { nonceError, sendWithNonce } from './nonces';
import { relayerFor } from './relayers';
import { reserveGas, serverState, settleGas } from './state';

export const publicClient = createPublicClient({
  chain,
  transport: (options) => {
    let rpc = serverRpcUrl();
    let active = http(rpc, { timeout: 10_000 })(options);
    return {
      ...active,
      request: (args, requestOptions) => {
        const next = serverRpcUrl();
        if (next !== rpc) {
          rpc = next;
          active = http(rpc, { timeout: 10_000 })(options);
        }
        return active.request(args, requestOptions) as never;
      },
    };
  },
  pollingInterval: IS_LOCAL ? 250 : 400,
});

/**
 * Fee caps at twice the base fee, not viem's 1.2x: a transaction whose cap the base fee rises past is stuck, and every
 * later one from its relayer waits behind it until the nonces are reused (STALL_MS). A transaction pays the base fee
 * plus its tip, not its cap, so the headroom costs nothing.
 */
const feeChain = { ...chain, fees: { ...chain.fees, baseFeeMultiplier: 2 } };

// Routes have 60s (maxDuration): past this, the action is reported as pending rather than cut off by the platform.
const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Sends a call as the relayer that serves `actor` (the Account it's for, or the owner for sign-ups): simulates it
 * first, so reverts cost nothing and surface the contract's error, then sends it with a gas limit 10% above the
 * estimate. Monad charges the gas limit, not the gas used, so it stays tight, and a call whose limit is over `maxGas`
 * is refused. The gas limit is reserved in the hourly budget first, then settled to the receipt's gasUsed.
 *
 * What the call created is in the receipt's logs: the simulation's return value is a guess that concurrent
 * transactions make wrong (e.g. the address of an Account, which the factory derives from its nonce).
 */
export async function sendAsRelayer<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, 'nonpayable' | 'payable'>,
>(
  call: {
    address: Address;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, 'nonpayable' | 'payable', functionName>;
  },
  actor: Address,
  maxGas: bigint
): Promise<{ hash: Hex; blockNumber: bigint; logs: Log[] }> {
  const relayer = await relayerFor(actor);
  // Callers' calls are checked against the ABI above; viem's generic types don't narrow through the helper.
  const params = { ...call, account: relayer } as never;
  try {
    await publicClient.simulateContract(params);
  } catch (error) {
    await assertRelayerAllowed(call.address, relayer, error);
    throw error;
  }
  const gas = gasLimit(await publicClient.estimateContractGas(params));
  // E.g. rules on a replied-to post, or a follow rule, that the caller chose to make expensive.
  if (gas > maxGas) {
    throw new HttpError(
      400,
      `This action costs more than ${currentConfig().appName} pays for. Pay its fee from your wallet (Settings).`
    );
  }
  const fees = await publicClient.estimateFeesPerGas({ chain: feeChain });
  const transaction = {
    chainId: chain.id,
    type: 'eip1559' as const,
    to: call.address,
    data: encodeFunctionData(call as never),
    gas,
    ...fees,
  };

  const reservation = await reserveGas(gas);
  let hash: Hex;
  try {
    ({ hash } = await sendWithNonce({
      store: serverState().nonces,
      relayer: relayer.address,
      chainNonce: () =>
        publicClient.getTransactionCount({ address: relayer.address, blockTag: 'pending' }),
      broadcast: async (nonce) =>
        broadcast(await relayer.signTransaction({ ...transaction, nonce }), relayer),
    }));
  } catch (error) {
    await settleGas(reservation, 0n);
    throw error;
  }

  let receipt;
  try {
    receipt = await waitForReceipt(hash);
  } catch (error) {
    // The reservation stays: the transaction may still go in.
    if (error instanceof WaitForTransactionReceiptTimeoutError) {
      throw new HttpError(504, `Sent, but not confirmed yet (${hash}). Check again in a minute.`);
    }
    throw error;
  }
  await settleGas(reservation, receipt.gasUsed);
  if (receipt.status !== 'success') {
    throw new Error(`Transaction ${hash} reverted`);
  }
  return { hash, blockNumber: receipt.blockNumber, logs: receipt.logs };
}

/**
 * A sent transaction's receipt, asked for once a block (the client's polling interval) until `timeout`. Not viem's
 * waitForTransactionReceipt, which also polls the block number, and looks the transaction up to notice a replacement:
 * Monad's RPC only returns transactions that are in a block
 * ([JSON-RPC overview](https://docs.monad.xyz/reference/json-rpc/overview)), so the lookup fails and retries with a
 * growing backoff until the transaction is in, and can't notice one.
 */
export async function waitForReceipt(
  hash: Hex,
  timeout = RECEIPT_TIMEOUT_MS
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeout;
  for (;;) {
    // A transaction just sent is in the next block at the earliest.
    await new Promise((resolve) => setTimeout(resolve, publicClient.pollingInterval));
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new WaitForTransactionReceiptTimeoutError({ hash });
    }
  }
}

/**
 * The router refuses a relayer it doesn't allowlist with the same error as an Account acting for another
 * (InvalidMsgSender). When that's the cause (a key missing from the allowlist, or revoked by its owner), it's ours.
 */
async function assertRelayerAllowed(target: Address, relayer: PrivateKeyAccount, error: unknown) {
  if (
    !isAddressEqual(target, (await getSponsorshipConfig()).sponsorRouter) ||
    lensErrorName(error) !== 'InvalidMsgSender'
  ) {
    return;
  }
  const allowed = await publicClient.readContract({
    address: (await getSponsorshipConfig()).sponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'isRelayer',
    args: [relayer.address],
  });
  if (!allowed) {
    console.error(`Relayer ${relayer.address} isn't allowlisted on the SponsorRouter`);
    throw new HttpError(
      503,
      `${currentConfig().appName} can't pay network fees right now. Try again soon, or pay from your wallet (Settings).`
    );
  }
}

/**
 * Broadcasts a signed transaction, once: a retry after a lost response would come back as a nonce error for a
 * transaction that went in. A nonce error for a transaction the node already has is a success.
 */
async function broadcast(serialized: Hex, relayer: PrivateKeyAccount): Promise<Hex> {
  const hash = keccak256(serialized);
  try {
    return await publicClient.request(
      { method: 'eth_sendRawTransaction', params: [serialized] },
      { retryCount: 0 }
    );
  } catch (error) {
    if (nonceError(error) && (await isKnown(hash))) {
      return hash;
    }
    console.warn(`Relayer ${relayer.address} broadcast failed:`, error);
    throw error;
  }
}

async function isKnown(hash: Hex) {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch {
    return false;
  }
}

export async function ownerOf(account: Address): Promise<Address | null> {
  try {
    return await publicClient.readContract({
      address: account,
      abi: accountAbi,
      functionName: 'owner',
    });
  } catch {
    return null;
  }
}

export async function isOwnedBy(account: Address, owner: Address) {
  const actualOwner = await ownerOf(account);
  return actualOwner !== null && isAddressEqual(actualOwner, owner);
}

/** Whether the SponsorRouter can execute transactions for the Account. */
export async function isSponsored(account: Address) {
  return publicClient.readContract({
    address: account,
    abi: accountAbi,
    functionName: 'canExecuteTransactions',
    args: [(await getSponsorshipConfig()).sponsorRouter],
  });
}
