'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAddressEqual, type Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { useConnection, useSignMessage } from 'wagmi';
import { useBrand } from '@/lib/runtime-config';
import { CHAIN_ID } from './config';

export type Session = {
  owner: Address | null;
  account: Address | null;
  /** 'passport' when signed in through Community Passport: no wallet, and the app always relays. */
  via?: 'passport' | null;
  /** This instance's admin role for the signed-in wallet, if it has one. */
  role?: 'owner' | 'admin' | 'moderator' | null;
};

const SESSION_KEY = ['session'];

/** An API error, with the response's status and body: e.g. `reauth`, to send a Passport member to sign in again. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status, body);
  }
  return body;
}

/** Community Passport sign-in: a navigation, since the Passport's page takes over. Comes back to `returnTo`. */
export function passportSignInUrl(returnTo = currentPath()) {
  return `/api/auth/passport?returnTo=${encodeURIComponent(returnTo)}`;
}
function currentPath() {
  return typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
}

/**
 * The server session (SIWE). It's what authorizes sponsored actions, so it stands on its own after a reload, before
 * or without the wallet reconnecting. If a *different* wallet connects, the session is treated as signed out, so the
 * UI never acts for an account the user isn't looking at.
 */
export function useSession() {
  const { APP_NAME } = useBrand();
  const queryClient = useQueryClient();
  const { address } = useConnection();
  const { mutateAsync: signMessage } = useSignMessage();

  const { data, isLoading, isError } = useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => api<Session>('/api/auth/session'),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const session: Session = !isError && data ? data : { owner: null, account: null };
  // A Passport session has no wallet: a connected wallet is someone else's business, not a different user.
  const passport = session.via === 'passport';
  const otherWallet =
    !passport && !!address && !!session.owner && !isAddressEqual(address, session.owner);
  const owner = otherWallet ? null : session.owner;
  const account = otherWallet ? null : session.account;
  const role = otherWallet ? null : (session.role ?? null);

  const signIn = useMutation({
    mutationFn: async () => {
      if (!address) {
        throw new Error('Connect a wallet first');
      }
      const { nonce } = await api<{ nonce: string }>('/api/auth/nonce');
      const message = createSiweMessage({
        address,
        chainId: CHAIN_ID,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        version: '1',
        statement: `Sign in to ${APP_NAME}. This signature is free and sends no transaction.`,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 10 * 60 * 1000),
      });
      const signature = await signMessage({ message });
      return api<Session>('/api/auth/verify', { method: 'POST', body: { message, signature } });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(SESSION_KEY, {
        owner: next.owner,
        account: next.account,
        via: null,
      });
      void queryClient.invalidateQueries({ queryKey: ['likes'] });
    },
  });

  const signOut = useMutation({
    mutationFn: () => api<Session>('/api/auth/session', { method: 'DELETE', body: {} }),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_KEY, { owner: null, account: null });
      void queryClient.invalidateQueries({ queryKey: ['likes'] });
    },
  });

  const selectAccount = useMutation({
    mutationFn: (selected: Address) =>
      api<Session>('/api/auth/session', { method: 'PUT', body: { account: selected } }),
    onSuccess: (next) =>
      queryClient.setQueryData(SESSION_KEY, { owner: next.owner, account: next.account }),
  });

  return {
    isLoading,
    /** The connected wallet, signed in. */
    owner,
    /** The Lens Account the user acts as. */
    account,
    /** The wallet's admin role on this instance: only for showing links, the server checks it again. */
    role,
    /** Signed in through Community Passport. */
    passport,
    /** Connected, but the session is for nobody or another wallet. */
    needsSignIn: !isLoading && !passport && !!address && (!session.owner || otherWallet),
    signIn,
    signOut,
    selectAccount,
    setAccount: (next: Address) =>
      queryClient.setQueryData(SESSION_KEY, { ...session, account: next }),
  };
}
