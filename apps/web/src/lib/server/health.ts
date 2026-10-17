import { sponsorRouterAbi } from '@lens-monad/protocol';
import { formatEther, parseEther, type Address } from 'viem';
import { APP_NAME } from '../brand';
import { CHAIN_ID, contracts } from '../config';
import { publicClient } from './chain';
import { database } from './db';
import { indexerUrl, numberEnv } from './env';
import { isPaused } from './guard';
import { relayers } from './relayers';
import { gasBudgetPerHour, serverState } from './state';

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
  database: { ok: boolean } | null;
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

export function checkHealth(): Promise<Health> {
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

  const [chainId, head, relayerList, indexer, databaseOk, used] = await Promise.all([
    attempt('chain id', () => publicClient.getChainId()),
    attempt('head', () => publicClient.getBlockNumber({ cacheTime: 0 })),
    attempt('relayers', () => checkRelayers(minBalance)),
    attempt('indexer', indexerStatus),
    sql
      ? attempt('database', async () => {
          await sql`SELECT 1`;
          return true;
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
  if (sql && !databaseOk) {
    problems.push('The database is unreachable');
  }
  let budget: bigint | null = null;
  try {
    budget = gasBudgetPerHour();
  } catch {
    problems.push('SPONSOR_GAS_BUDGET_PER_HOUR is invalid');
  }
  // Transactions that don't fit are refused before the budget is full: flag it once a sign-up no longer fits.
  if (budget !== null && used !== null && budget - used < SIGN_UP_GAS) {
    problems.push("This hour's sponsored gas budget is nearly spent");
  }

  return {
    app: APP_NAME,
    healthy: problems.length === 0,
    problems,
    chainId: CHAIN_ID,
    head: head === null ? null : Number(head),
    paused: isPaused(),
    sharedState: sql !== null,
    database: sql ? { ok: databaseOk === true } : null,
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
    relayers().map(async ({ address }) => {
      const [balance, allowlisted] = await Promise.all([
        attempt(`balance of ${address}`, () => publicClient.getBalance({ address })),
        attempt(`allowlist of ${address}`, () =>
          publicClient.readContract({
            address: contracts.SponsorRouter,
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
async function indexerStatus(): Promise<{ block: number } | { otherChains: number[] }> {
  const response = await fetch(`${indexerUrl()}/status`, {
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
