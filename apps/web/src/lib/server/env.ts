import { isAddressEqual, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { IS_LOCAL } from '../config';

// Anvil's 4th account, which DeployLaunch allowlists as relayer on chain 31337. Public, so local only.
const LOCAL_RELAYER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const LOCAL_SESSION_SECRET = 'local-development-only-session-secret-0123456789';
const LOCAL_INDEXER_URL = 'http://127.0.0.1:42069';

function required(name: string, localDefault: string): string {
  const value = process.env[name];
  if (value) {
    return value;
  }
  if (IS_LOCAL) {
    return localDefault;
  }
  throw new Error(`${name} must be set outside the local chain`);
}

/**
 * The relayer keys, from RELAYER_PRIVATE_KEYS (comma-separated) or RELAYER_PRIVATE_KEY. Each needs to be one of the
 * SponsorRouter's relayers, funded with MON. Their order picks which relayer sends for which Account, so keep it.
 */
export function relayerKeys(): Hex[] {
  const list =
    process.env.RELAYER_PRIVATE_KEYS || required('RELAYER_PRIVATE_KEY', LOCAL_RELAYER_KEY);
  const keys = list
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw new Error('RELAYER_PRIVATE_KEYS is empty');
  }
  for (const key of keys) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('Relayer keys must be 32-byte hex private keys');
    }
  }
  const addresses = keys.map((key) => privateKeyToAddress(key as Hex));
  if (
    addresses.some((address, i) => addresses.findIndex((a) => isAddressEqual(a, address)) !== i)
  ) {
    throw new Error('A relayer key is listed twice');
  }
  return keys as Hex[];
}

export function sessionSecret(): string {
  const secret = required('SESSION_SECRET', LOCAL_SESSION_SECRET);
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return secret;
}

/** The indexer's base URL, without a trailing slash. next.config.ts reads the same variable for the /indexer proxy. */
export function indexerUrl(): string {
  return required('INDEXER_URL', LOCAL_INDEXER_URL).replace(/\/+$/, '');
}

/** A server-only RPC (e.g. a paid one, with its key in the URL), or NEXT_PUBLIC_RPC_URL, which browsers use too. */
export function serverRpcUrl(): string | undefined {
  return process.env.RPC_URL || undefined;
}

/** Postgres for the state instances share: relayer nonces, rate limits, the gas budget. In memory without it. */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || undefined;
}

export function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function booleanEnv(name: string): boolean {
  return ['true', '1'].includes(process.env[name]?.trim().toLowerCase() ?? '');
}
