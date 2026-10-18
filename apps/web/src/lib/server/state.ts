import { CHAIN_ID } from '../config';
import { database, nonceDatabase } from './db';
import { gasBudgetPerHour } from './env';
import { HttpError } from './guard';
import {
  memoryGasBudget,
  memoryRateLimiter,
  postgresGasBudget,
  postgresRateLimiter,
  type GasBudget,
  type GasReservation,
  type RateLimiter,
} from './limits';
import { memoryLikeStore, postgresLikeStore, type LikeStore } from './likes';
import { memoryNonceStore, postgresNonceStore, type NonceStore } from './nonces';

type State = {
  /** Whether the state is in Postgres, shared by every instance. */
  shared: boolean;
  rateLimiter: RateLimiter;
  gasBudget: GasBudget;
  nonces: NonceStore;
  likes: LikeStore;
};

let state: State | undefined;

/**
 * Postgres when DATABASE_URL is set, so that serverless instances share it; memory otherwise. Likes live there too:
 * they're Parallax's own, not on-chain.
 */
export function serverState(): State {
  if (!state) {
    const sql = database();
    state = sql
      ? {
          shared: true,
          rateLimiter: postgresRateLimiter(sql),
          gasBudget: postgresGasBudget(sql, CHAIN_ID),
          nonces: postgresNonceStore(nonceDatabase, CHAIN_ID),
          likes: postgresLikeStore(sql, CHAIN_ID),
        }
      : {
          shared: false,
          rateLimiter: memoryRateLimiter(),
          gasBudget: memoryGasBudget(),
          nonces: memoryNonceStore(),
          likes: memoryLikeStore(),
        };
  }
  return state;
}

/** Throws a 429 once `key` was hit `limit` times in the last `windowMs`. Keys are case-insensitive (addresses). */
export async function rateLimit(key: string, limit: number, windowMs: number) {
  const scoped = `${CHAIN_ID}:${key.toLowerCase()}`;
  if (!(await serverState().rateLimiter.hit(scoped, limit, windowMs))) {
    throw new HttpError(429, 'Too many requests, try again in a bit.');
  }
}

// Only the local chain sponsors without a budget (missingSponsorSettings): gas is still counted (see /api/health),
// against a limit nothing reaches.
const NO_BUDGET = 2n ** 62n;

/** Reserves a transaction's gas limit in this hour's budget, or refuses the action when it's spent. */
export async function reserveGas(gas: bigint): Promise<GasReservation> {
  const reservation = await serverState().gasBudget.reserve(gas, gasBudgetPerHour() ?? NO_BUDGET);
  if (!reservation) {
    throw new HttpError(
      503,
      'Free actions are used up for this hour. Try again later, or pay the gas from your wallet (Settings).'
    );
  }
  return reservation;
}

/** Settles a reservation to the gas used. Bookkeeping: a failure is logged, not shown to the user. */
export async function settleGas(reservation: GasReservation, used: bigint) {
  try {
    await serverState().gasBudget.settle(reservation, used);
  } catch (error) {
    console.error('Could not settle the gas budget', error);
  }
}
