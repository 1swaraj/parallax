'use client';

import {
  accountAbi,
  accountFactoryAbi,
  accountMetadata,
  createAccountWithUsernameArgs,
  describeLensError,
  directExecution,
  feedAbi,
  lensFactoryAbi,
  mediaId,
  putMedia,
  SPONSOR_ROUTER_PERMISSIONS,
  toDataURI,
  type AccountCall,
} from '@lens-monad/protocol';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import {
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { useConfig, useConnection, useReadContract } from 'wagmi';
import {
  getBytecode,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
} from 'wagmi/actions';
import { CHAIN_ID, contracts as defaultContracts, mediaStore, MIRROR } from './config';
import { useNetwork } from './runtime-config';
import { useProfile, waitForIndexer } from './indexer';
import { api, useSession } from './session';

export type GasMode = 'sponsored' | 'direct';

const GAS_MODE_KEY = 'lens:gas-mode';
const listeners = new Set<() => void>();

function readGasMode(): GasMode {
  return typeof window !== 'undefined' && window.localStorage.getItem(GAS_MODE_KEY) === 'direct'
    ? 'direct'
    : 'sponsored';
}

/** Whether actions go through the relayer (free) or the user's wallet (paid in MON). Stored in the browser. */
export function useGasMode(): [GasMode, (mode: GasMode) => void] {
  const mode = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readGasMode,
    () => 'sponsored' as const
  );
  const setMode = useCallback((next: GasMode) => {
    window.localStorage.setItem(GAS_MODE_KEY, next);
    listeners.forEach((listener) => listener());
  }, []);
  return [mode, setMode];
}

const SPONSORSHIP_QUERY = {
  queryKey: ['sponsorship'],
  queryFn: async () => (await api<{ available: boolean }>('/api/sponsorship')).available,
  staleTime: 60_000,
};

/**
 * Whether the app pays network fees right now (e.g. not on a network where it has no relayers). Undefined while
 * loading: actions wait for it, and the UI assumes it does.
 */
export function useSponsorship() {
  // A mirror's client sends nothing to pay for.
  return useQuery({ ...SPONSORSHIP_QUERY, enabled: !MIRROR }).data;
}

/** Whether the app pays network fees right now, asking the server if it hasn't yet. */
function sponsorshipAvailable(queryClient: QueryClient) {
  return queryClient.fetchQuery(SPONSORSHIP_QUERY).catch(() => false);
}

export type Profile = { name?: string; bio?: string; picture?: string };

/** What an action did: its block (to wait for the indexer), and the post it created, if any. */
export type ActionResult = { blockNumber: bigint; postId: string | null };

function postIdIn(logs: Log[]): string | null {
  const [event] = parseEventLogs({ abi: feedAbi, eventName: 'Lens_Feed_PostCreated', logs });
  return event ? event.args.postId.toString() : null;
}

export function createdPostId(result: ActionResult): string | null {
  return result.postId;
}

/**
 * Sends Lens actions for the signed-in Account, sponsored through the app's relayer or directly from the owner's
 * wallet, then waits for the indexer so the UI shows the result.
 */
export function useLensActions() {
  const { contracts } = useNetwork();
  const config = useConfig();
  const queryClient = useQueryClient();
  const { chainId, address } = useConnection();
  const { owner, account, setAccount } = useSession();
  const [gasMode] = useGasMode();
  const available = useSponsorship();
  const { data: profile } = useProfile(account, null);
  // Accounts created elsewhere may not have the SponsorRouter as manager: their owner pays.
  const permission = useReadContract({
    chainId: CHAIN_ID,
    address: account ?? undefined,
    abi: accountAbi,
    functionName: 'canExecuteTransactions',
    args: [contracts.SponsorRouter],
    query: { enabled: !!account && !MIRROR, staleTime: 5_000, refetchInterval: 15_000 },
  });
  const sponsorshipAllowed =
    permission.data ??
    (isAddressEqual(contracts.SponsorRouter, defaultContracts.SponsorRouter)
      ? profile?.account.sponsored
      : undefined);
  // The app pays unless the user chose their wallet (Settings), the app can't pay right now, or the Account
  // doesn't have the SponsorRouter as manager.
  const sponsored = gasMode === 'sponsored' && available !== false && (sponsorshipAllowed ?? true);

  const sendFromWallet = useCallback(
    async (to: Address, data: Hex) => {
      if (!address) {
        throw new Error('Connect the wallet that owns this account to pay from it.');
      }
      if (owner && !isAddressEqual(address, owner)) {
        throw new Error(
          "The connected wallet doesn't own this account. Switch wallets and try again."
        );
      }
      if (chainId !== CHAIN_ID) {
        await switchChain(config, { chainId: CHAIN_ID });
      }
      const hash = await sendTransaction(config, { to, data, chainId: CHAIN_ID });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: CHAIN_ID });
      if (receipt.status !== 'success') {
        throw new Error('The transaction reverted');
      }
      return receipt;
    },
    [config, chainId, address, owner]
  );

  /** The relayer already waited for the receipt, and says which post it created. */
  const relay = useCallback(async (path: string, body: unknown): Promise<ActionResult> => {
    const result = await api<{ blockNumber: string; postId?: string | null }>(path, {
      method: 'POST',
      body,
    });
    return { blockNumber: BigInt(result.blockNumber), postId: result.postId ?? null };
  }, []);

  /** Sends a call for the Account, sponsored or from the wallet, and waits for its receipt (not the indexer). */
  const send = useCallback(
    async (account: Address, call: AccountCall): Promise<ActionResult> =>
      sponsored
        ? relay('/api/relay', call)
        : sendFromWallet(account, directExecution(call)).then((receipt) => ({
            blockNumber: receipt.blockNumber,
            postId: postIdIn(receipt.logs),
          })),
    [sponsored, relay, sendFromWallet]
  );

  const run = useCallback(
    async (call: AccountCall | ((account: Address) => AccountCall)): Promise<ActionResult> => {
      if (!account) {
        throw new Error('Sign in with a Lens account first');
      }
      if (gasMode === 'sponsored' && !permission.isSuccess) {
        throw new Error('Checking network fee permissions. Try again in a moment.');
      }
      const resolved = typeof call === 'function' ? call(account) : call;
      try {
        const result = await send(account, resolved);
        await waitForIndexer(queryClient, result.blockNumber);
        return result;
      } catch (error) {
        throw new Error(describeLensError(error));
      }
    },
    [account, gasMode, permission.isSuccess, send, queryClient]
  );

  /**
   * Stores an image on-chain as the Account's media, one transaction per chunk (one wallet prompt each when the
   * wallet pays), and returns its id once the app serves it, so a post never shows an image that isn't there. An
   * image the indexer already has, e.g. from a post that failed after its upload, isn't sent again.
   */
  const uploadMedia = useCallback(
    async (bytes: Uint8Array, onProgress?: (sent: number, total: number) => void) => {
      if (!account) {
        throw new Error('Sign in with a Lens account first');
      }
      if (!mediaStore) {
        throw new Error("Images aren't available on this network yet");
      }
      const id = await mediaId(bytes);
      const served = async () => (await fetch(`/media/${account}/${id}`, { method: 'HEAD' })).ok;
      if (await served()) {
        return { author: account, id };
      }
      // A call to an address without code succeeds and does nothing: the fees would be paid for an image no one
      // can read.
      if (!(await getBytecode(config, { address: mediaStore.address, chainId: CHAIN_ID }))) {
        throw new Error("Images aren't available on this network yet");
      }
      const calls = putMedia(mediaStore.address, id, bytes);
      let blockNumber = 0n;
      try {
        for (const [i, call] of calls.entries()) {
          onProgress?.(i, calls.length);
          ({ blockNumber } = await send(account, call));
        }
      } catch (error) {
        throw new Error(describeLensError(error));
      }
      onProgress?.(calls.length, calls.length);
      await waitForIndexer(queryClient, blockNumber);
      if (!(await served())) {
        throw new Error("The image was sent but can't be read back. Try posting it again.");
      }
      return { author: account, id };
    },
    [account, send, config, queryClient]
  );

  const signUp = useCallback(
    async (
      params: { username: string; inviteCode?: string; turnstileToken?: string } & Profile
    ) => {
      if (!owner) {
        throw new Error('Sign in first');
      }
      try {
        if (gasMode === 'sponsored' && (await sponsorshipAvailable(queryClient))) {
          const result = await api<{ account: Address; blockNumber: string }>('/api/signup', {
            method: 'POST',
            body: params,
          });
          await waitForIndexer(queryClient, BigInt(result.blockNumber));
          setAccount(result.account);
          return result.account;
        }
        // Direct: the owner sends LensFactory's transaction, and still adds the SponsorRouter for later.
        await api('/api/signup', { method: 'PUT', body: params });
        const receipt = await sendFromWallet(
          contracts.LensFactory,
          encodeFunctionData({
            abi: lensFactoryAbi,
            functionName: 'createAccountWithUsernameFree',
            args: createAccountWithUsernameArgs({
              namespace: contracts.LensGlobalNamespace,
              owner,
              username: params.username,
              metadataURI: toDataURI(accountMetadata(params)),
              sponsorRouter: (await api<{ sponsorRouter: Address }>('/api/instance')).sponsorRouter,
            }),
          })
        );
        const [created] = parseEventLogs({
          abi: accountFactoryAbi,
          eventName: 'Lens_Account_Created',
          logs: receipt.logs,
        });
        if (!created) {
          throw new Error('The account was not created');
        }
        await waitForIndexer(queryClient, receipt.blockNumber);
        // The server checks ownership on its own RPC, which can be a block behind the wallet's.
        for (let attempt = 0; ; attempt++) {
          try {
            await api('/api/auth/session', {
              method: 'PUT',
              body: { account: created.args.account, signup: true },
            });
            break;
          } catch (error) {
            if (attempt >= 4) {
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        setAccount(created.args.account);
        return created.args.account;
      } catch (error) {
        throw new Error(describeLensError(error));
      }
    },
    [owner, gasMode, queryClient, sendFromWallet, setAccount]
  );

  const updateProfile = useCallback(
    async (params: Profile) => {
      if (!account) {
        throw new Error('Sign in with a Lens account first');
      }
      try {
        if (gasMode === 'sponsored' && !permission.isSuccess) {
          throw new Error('Checking network fee permissions. Try again in a moment.');
        }
        let blockNumber: bigint;
        if (sponsored) {
          blockNumber = (await relay('/api/profile', params)).blockNumber;
        } else {
          const data = encodeFunctionData({
            abi: accountAbi,
            functionName: 'setMetadataURI',
            args: [toDataURI(accountMetadata(params))],
          });
          blockNumber = (await sendFromWallet(account, data)).blockNumber;
        }
        await waitForIndexer(queryClient, blockNumber);
      } catch (error) {
        throw new Error(describeLensError(error));
      }
    },
    [account, sponsored, gasMode, permission.isSuccess, relay, sendFromWallet, queryClient]
  );

  /** Adds the SponsorRouter as manager, from the owner's wallet, so that the relayer can pay from then on. */
  const enableSponsorship = useCallback(async () => {
    if (!account) {
      throw new Error('Sign in with a Lens account first');
    }
    try {
      const data = encodeFunctionData({
        abi: accountAbi,
        functionName: 'addAccountManager',
        args: [
          (await api<{ sponsorRouter: Address }>('/api/instance')).sponsorRouter,
          SPONSOR_ROUTER_PERMISSIONS,
        ],
      });
      await waitForIndexer(queryClient, (await sendFromWallet(account, data)).blockNumber);
      await permission.refetch();
    } catch (error) {
      throw new Error(describeLensError(error));
    }
  }, [account, sendFromWallet, queryClient, permission]);

  return {
    run,
    uploadMedia,
    signUp,
    updateProfile,
    enableSponsorship,
    sponsorshipAllowed,
    sponsored,
    account,
  };
}
