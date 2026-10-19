import { getSponsorshipConfig } from './sponsorship-config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sponsorRouterAbi } from '@lens-monad/protocol';
import { createPublicClient, http, formatEther, parseEther, type Address } from 'viem';
import { getInstanceConfig, currentConfig } from './instance-config';
import { CHAIN_ID } from '../config';
import { runtimeContracts as contracts } from './contracts';
import { publicClient } from './chain';
import { database, migrationsApplied } from './db';
import {
  gasBudgetPerHour,
  healthToken,
  indexerUrl,
  maxGasPerSignUp,
  maxGasPerTransaction,
  missingSponsorSettings,
  numberEnv,
} from './env';
import { isPaused } from './guard';
import { relayers } from './relayers';
import { serverState } from './state';

type RelayerHealth = {
  address: Address;
  /** In MON. */
  balance: string | null;
  low: boolean;
  /** Whether the SponsorRouter lets it relay. */
  allowlisted: boolean | null;
};

export type Health = {
  app: string;
  healthy: boolean;
  /** What makes it unhealthy, for whoever gets paged. */
  problems: string[];
  chainId: number;
  head: number | null;
  paused: boolean;
  /** Whether nonces, rate limits and the gas budget are in Postgres (DATABASE_URL), shared by every instance. */
  sharedState: boolean;
  database: { ok: boolean; migrated: boolean } | null;
  sponsorRouter: Address | null;
  relayers: RelayerHealth[];
  indexer: { block: number | null; lag: number | null };
  gas: { usedThisHour: string | null; budgetPerHour: string | null };
};

const CHECK_TIMEOUT_MS = 5_000;
// A sign-up's gas limit (~2.2M used, +10%), the most expensive sponsored action.
const SIGN_UP_GAS = 2_500_000n;
// Health is public: one check per instance every few seconds, however often it's polled.
const CACHE_MS = 5_000;

let cached: { at: number; health: Promise<Health> } | undefined;

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

/**
 * Whether a request may see the details (relayers, balances, gas, problems): with `Authorization: Bearer
 * <HEALTH_TOKEN>`. Compared in constant time, as digests so the lengths match.
 */
export function canSeeHealthDetails(authorization: string | null): boolean {
  const token = healthToken();
  const presented = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
  return !!token && !!presented && timingSafeEqual(digest(presented), digest(token));
}

export async function checkHealth(): Promise<Health> {
  await getInstanceConfig();
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), health: check() };
  }
  return cached.health;
}

/** The value, or null if it failed or took too long. Errors are logged, never returned: they can hold RPC keys. */
async function attempt<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS)
      ),
    ]);
  } catch (error) {
    console.error(`Health check ${name} failed:`, error);
    return null;
  }
}

async function check(): Promise<Health> {
  const problems: string[] = [];
  const minBalance = parseEther(String(numberEnv('RELAYER_MIN_BALANCE_MON', 5)));
  const maxLag = numberEnv('INDEXER_MAX_LAG_BLOCKS', 50);
  const sql = database();

  const config = await attempt('instance router', getSponsorshipConfig);
  if (!config) problems.push('The instance router configuration is invalid');
  const [chainId, head, relayerList, indexer, databaseStatus, used] = await Promise.all([
    attempt('chain id', () => publicClient.getChainId()),
    attempt('head', () => publicClient.getBlockNumber({ cacheTime: 0 })),
    attempt('relayers', () => checkRelayers(minBalance)),
    attempt('indexer', indexerStatus),
    sql
      ? attempt('database', async () => {
          await sql`SELECT 1`;
          return { migrated: await migrationsApplied(sql) };
        })
      : null,
    attempt('gas', () => serverState().gasBudget.usedThisHour()),
  ]);

  if (chainId === null || head === null) {
    problems.push('The RPC is unreachable');
  } else if (chainId !== CHAIN_ID) {
    problems.push(`The RPC is on chain ${chainId}, the app on ${CHAIN_ID}`);
  }
  if (relayerList === null) {
    problems.push('The relayer keys are missing or invalid');
  }
  for (const relayer of relayerList ?? []) {
    if (relayer.balance === null || relayer.allowlisted === null) {
      problems.push(`Relayer ${relayer.address} could not be checked`);
    }
    if (relayer.low) {
      problems.push(`Relayer ${relayer.address} has under ${formatEther(minBalance)} MON`);
    }
    if (relayer.allowlisted === false) {
      problems.push(`Relayer ${relayer.address} isn't allowlisted on the SponsorRouter`);
    }
  }
  const indexed = indexer && 'block' in indexer ? indexer.block : null;
  const lag = head !== null && indexed !== null ? Number(head) - indexed : null;
  if (indexer === null) {
    problems.push('The indexer is unreachable');
  } else if ('otherChains' in indexer) {
    problems.push(`The indexer indexes chain ${indexer.otherChains.join(', ')}, not ${CHAIN_ID}`);
  } else if (lag !== null && lag > maxLag) {
    problems.push(`The indexer is ${lag} blocks behind`);
  }
  if (sql && !databaseStatus) {
    problems.push('The database is unreachable');
  } else if (databaseStatus && !databaseStatus.migrated) {
    problems.push('Database migrations are missing; run pnpm db:migrate');
  }
  let budget: bigint | null = null;
  try {
    budget = gasBudgetPerHour();
    for (const name of missingSponsorSettings()) {
      problems.push(`${name} isn't set, so sponsored actions are refused`);
    }
  } catch {
    problems.push('SPONSOR_GAS_BUDGET_PER_HOUR is invalid');
  }
  const caps = [
    ['SPONSOR_MAX_GAS_PER_TX', maxGasPerTransaction],
    ['SPONSOR_MAX_GAS_PER_SIGNUP', maxGasPerSignUp],
  ] as const;
  for (const [name, read] of caps) {
    try {
      read();
    } catch {
      problems.push(`${name} is invalid`);
    }
  }
  // Transactions that don't fit are refused before the budget is full: flag it once a sign-up no longer fits.
  if (budget !== null && used !== null && budget - used < SIGN_UP_GAS) {
    problems.push("This hour's sponsored gas budget is nearly spent");
  }

  return {
    app: currentConfig().appName,
    healthy: problems.length === 0,
    problems,
    chainId: CHAIN_ID,
    head: head === null ? null : Number(head),
    paused: isPaused(),
    sharedState: sql !== null,
    database: sql
      ? { ok: databaseStatus !== null, migrated: databaseStatus?.migrated === true }
      : null,
    sponsorRouter: config?.sponsorRouter ?? null,
    relayers: relayerList ?? [],
    indexer: { block: indexed, lag },
    gas: {
      usedThisHour: used === null ? null : used.toString(),
      budgetPerHour: budget === null ? null : budget.toString(),
    },
  };
}

async function checkRelayers(minBalance: bigint): Promise<RelayerHealth[]> {
  return Promise.all(
    (await relayers()).map(async ({ address }) => {
      const [balance, allowlisted] = await Promise.all([
        attempt(`balance of ${address}`, () => publicClient.getBalance({ address })),
        attempt(`allowlist of ${address}`, async () =>
          publicClient.readContract({
            address: (await getSponsorshipConfig()).sponsorRouter,
            abi: sponsorRouterAbi,
            functionName: 'isRelayer',
            args: [address],
          })
        ),
      ]);
      return {
        address,
        balance: balance === null ? null : formatEther(balance),
        low: balance !== null && balance < minBalance,
        allowlisted,
      };
    })
  );
}

/**
 * The block the indexer reached on the app's chain (Ponder's /status lists it per chain), or the chains it indexes
 * instead: an indexer left on its default chain (PONDER_CHAIN_ID unset) still answers.
 */
async function indexerStatus(
  url = indexerUrl()
): Promise<{ block: number } | { otherChains: number[] }> {
  const response = await fetch(`${url.replace(/\/+$/, '')}/status`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Indexer status ${response.status}`);
  }
  const chains = Object.values(
    (await response.json()) as Record<string, { id: number; block: { number: number } }>
  );
  const status = chains.find((entry) => entry.id === CHAIN_ID);
  return status ? { block: status.block.number } : { otherChains: chains.map((c) => c.id) };
}

/** The setup/admin check shares the health parser and timeout without changing saved config. */
export async function checkNetworkSettings(config: {
  serverRpcUrl: string;
  publicRpcUrl: string;
  indexerUrl: string;
}) {
  const checkRpc = async (url: string) => {
    const client = createPublicClient({
      transport: http(url, { timeout: CHECK_TIMEOUT_MS, retryCount: 0 }),
    });
    return client.getChainId();
  };
  const [browserChain, serverChain, indexer] = await Promise.all([
    attempt('browser RPC', () => checkRpc(config.publicRpcUrl)),
    attempt('server RPC', () => checkRpc(config.serverRpcUrl || config.publicRpcUrl)),
    attempt('indexer', () => indexerStatus(config.indexerUrl)),
  ]);
  const ok =
    browserChain === CHAIN_ID && serverChain === CHAIN_ID && indexer !== null && 'block' in indexer;
  return {
    ok,
    message: ok
      ? `Both RPCs are on chain ${CHAIN_ID}. Indexer reached block ${'block' in indexer! ? indexer!.block : '?'}.`
      : `Check failed. Browser RPC chain: ${browserChain ?? 'unreachable'}; server RPC chain: ${serverChain ?? 'unreachable'}; indexer: ${indexer && 'block' in indexer ? 'connected' : 'unreachable or wrong chain'}. Expected chain ${CHAIN_ID}.`,
  };
}
