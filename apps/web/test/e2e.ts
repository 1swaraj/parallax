// What the end-to-end tests share: the app's URL, its chain (from /api/health, so the tests run on any chain whose
// address book is synced), and a browser-like user with a wallet and a session cookie.

import { getDeployment } from '@lens-monad/protocol';
import { createPublicClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { Health } from '../src/lib/server/health';

export const APP = process.env.APP_URL ?? 'http://localhost:3000';
export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

export async function health(): Promise<{ status: number; body: Health }> {
  const response = await fetch(`${APP}/api/health`);
  return { status: response.status, body: (await response.json()) as Health };
}

export const { chainId: CHAIN_ID, relayers: RELAYERS } = (await health()).body;
export const { contracts } = getDeployment(CHAIN_ID);
export const chainClient = createPublicClient({ transport: http(RPC_URL) });

/** A browser: a wallet, and the session cookie the app sets. */
export function user(wallet = privateKeyToAccount(generatePrivateKey())) {
  let cookie = '';
  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown; origin?: string | null } = {}
  ) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.origin !== null) headers.origin = init.origin ?? APP;
    const response = await fetch(`${APP}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    return { status: response.status, body: (await response.json()) as T & { error?: string } };
  }
  async function signIn() {
    const { body } = await call<{ nonce: string }>('/api/auth/nonce');
    const message = createSiweMessage({
      address: wallet.address,
      chainId: CHAIN_ID,
      domain: new URL(APP).host,
      uri: APP,
      nonce: body.nonce,
      version: '1',
    });
    return call<{ owner: string; account: string | null }>('/api/auth/verify', {
      method: 'POST',
      body: { message, signature: await wallet.signMessage({ message }) },
    });
  }
  return { wallet, call, signIn };
}

export async function indexed<T>(path: string, until: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${APP}/indexer${path}`);
    if (response.ok) {
      const value = (await response.json()) as T;
      if (until(value)) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
