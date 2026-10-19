import type { ProfileView } from '@lens-monad/protocol';
import type { Address } from 'viem';
import { database } from './db';
import { indexerUrl } from './env';

/** Called after ownership is checked when a wallet-paid signup selects its new account. */
export async function recordDirectSignup(account: Address) {
  const sql = database();
  if (!sql) return;
  const response = await fetch(`${indexerUrl()}/accounts/${account}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Could not read the new account');
  const { account: indexed } = (await response.json()) as ProfileView;
  const createdAt = Number(indexed.createdAt) * 1000;
  if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > Date.now() + 60_000) return;
  await sql`INSERT INTO lens_web.signups (account, created_at) VALUES (${account.toLowerCase()}, ${new Date(createdAt)}) ON CONFLICT DO NOTHING`;
}
