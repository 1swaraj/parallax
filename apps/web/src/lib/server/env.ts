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
  // The local default is public: a Vercel deployment left on chain 31337 (e.g. a preview missing its variables) would
  // sign sessions anyone can forge.
  if (!process.env.SESSION_SECRET && process.env.VERCEL) {
    throw new Error('SESSION_SECRET must be set on Vercel');
  }
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

/**
 * Postgres for the state instances share: relayer nonces, rate limits, the gas budget. In memory without it, which
 * only the local chain allows sponsored actions with (see missingSponsorSettings).
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || undefined;
}

/** The app's public URL (NEXT_PUBLIC_APP_URL), or undefined when unset. */
export function appUrl(): URL | undefined {
  const value = process.env.NEXT_PUBLIC_APP_URL;
  return value ? new URL(value) : undefined;
}

/** HEALTH_TOKEN: the bearer token that unlocks /api/health's details. Without it, they're never shown. */
export function healthToken(): string | undefined {
  return process.env.HEALTH_TOKEN || undefined;
}

/** A gas amount (underscores allowed, e.g. 1_500_000), or null when unset. */
function gasEnv(name: string): bigint | null {
  const value = process.env[name]?.replace(/_/g, '').trim();
  if (!value) {
    return null;
  }
  if (!/^\d+$/.test(value) || BigInt(value) === 0n) {
    throw new Error(`${name} must be a positive number of gas units`);
  }
  return BigInt(value);
}

/** SPONSOR_GAS_BUDGET_PER_HOUR: the gas all relayers may spend per clock hour, or null when unset. */
export function gasBudgetPerHour(): bigint | null {
  return gasEnv('SPONSOR_GAS_BUDGET_PER_HOUR');
}

// Measured: a post uses ~0.76M gas, a sign-up ~2.14M. The caps leave room, and bound what one call can cost.
/** The highest gas limit the relayer sends a relayed action (post, follow, profile...) with. */
export function maxGasPerTransaction(): bigint {
  return gasEnv('SPONSOR_MAX_GAS_PER_TX') ?? 1_500_000n;
}

export function maxGasPerSignUp(): bigint {
  return gasEnv('SPONSOR_MAX_GAS_PER_SIGNUP') ?? 3_000_000n;
}

// Measured: a 64 KiB chunk of an image uses 2.64M gas, mostly calldata at 40 gas per byte (EIP-7623's floor); a post
// with an image ~1.2M with a short text, its metadata being bigger, and up to ~2M with a full text and description.
/** The highest gas limit the relayer sends a chunk of an image with (MediaStore.put). */
export function maxGasPerMediaChunk(): bigint {
  return gasEnv('SPONSOR_MAX_GAS_PER_MEDIA_CHUNK') ?? 3_200_000n;
}

/** The highest gas limit the relayer sends a post with an image with. */
export function maxGasPerImagePost(): bigint {
  return gasEnv('SPONSOR_MAX_GAS_PER_IMAGE_POST') ?? 2_500_000n;
}

/**
 * The settings sponsored actions can't run without outside the local chain: without a database, rate limits, nonces
 * and the budget are per instance; without a budget, the relayers' spending has no ceiling.
 */
export function missingSponsorSettings(): string[] {
  if (IS_LOCAL) {
    return [];
  }
  const missing: string[] = [];
  if (!databaseUrl()) {
    missing.push('DATABASE_URL');
  }
  if (gasBudgetPerHour() === null) {
    missing.push('SPONSOR_GAS_BUDGET_PER_HOUR');
  }
  return missing;
}

export function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function booleanEnv(name: string): boolean {
  return ['true', '1'].includes(process.env[name]?.trim().toLowerCase() ?? '');
}
