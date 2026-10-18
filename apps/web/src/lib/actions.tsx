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
  SPONSOR_ROUTER_PERMISSIONS,
  toDataURI,
  type AccountCall,
} from '@lens-monad/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import {
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { useConfig, useConnection } from 'wagmi';
import { sendTransaction, switchChain, waitForTransactionReceipt } from 'wagmi/actions';
import { CHAIN_ID, contracts } from './config';
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
  const config = useConfig();
  const queryClient = useQueryClient();
  const { chainId, address } = useConnection();
  const { owner, account, setAccount } = useSession();
  const [gasMode] = useGasMode();
  const { data: profile } = useProfile(account, null);
  // Accounts created elsewhere may not have the SponsorRouter as manager: their owner pays.
  const sponsored = gasMode === 'sponsored' && (profile?.account.sponsored ?? true);

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

  const run = useCallback(
    async (call: AccountCall | ((account: Address) => AccountCall)): Promise<ActionResult> => {
      if (!account) {
        throw new Error('Sign in with a Lens account first');
      }
      const resolved = typeof call === 'function' ? call(account) : call;
      try {
        const result = sponsored
          ? await relay('/api/relay', resolved)
          : await sendFromWallet(account, directExecution(resolved)).then((receipt) => ({
              blockNumber: receipt.blockNumber,
              postId: postIdIn(receipt.logs),
            }));
        await waitForIndexer(queryClient, result.blockNumber);
        return result;
      } catch (error) {
        throw new Error(describeLensError(error));
      }
    },
    [account, sponsored, relay, sendFromWallet, queryClient]
  );

  const signUp = useCallback(
    async (params: { username: string } & Profile) => {
      if (!owner) {
        throw new Error('Sign in first');
      }
      try {
        if (gasMode === 'sponsored') {
          const result = await api<{ account: Address; blockNumber: string }>('/api/signup', {
            method: 'POST',
            body: params,
          });
          await waitForIndexer(queryClient, BigInt(result.blockNumber));
          setAccount(result.account);
          return result.account;
        }
        // Direct: the owner sends LensFactory's transaction, and still adds the SponsorRouter for later.
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
              sponsorRouter: contracts.SponsorRouter,
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
              body: { account: created.args.account },
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
    [account, sponsored, relay, sendFromWallet, queryClient]
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
        args: [contracts.SponsorRouter, SPONSOR_ROUTER_PERMISSIONS],
      });
      await waitForIndexer(queryClient, (await sendFromWallet(account, data)).blockNumber);
    } catch (error) {
      throw new Error(describeLensError(error));
    }
  }, [account, sendFromWallet, queryClient]);

  return { run, signUp, updateProfile, enableSponsorship, sponsored, account };
}
