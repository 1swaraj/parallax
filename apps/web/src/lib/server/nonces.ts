import type { Address, Hex } from 'viem';
import { migrate, type Sql } from './db';
import { HttpError } from './guard';

/** What the allocator remembers per relayer: the next nonce to hand out, and the chain's, last time it looked. */
export type NonceState = {
  next: number;
  chainNonce: number;
  /** When the chain's nonce last moved, or last caught up with `next`. */
  progressAt: number;
};

/**
 * Holds one lock per relayer while a nonce is picked and the transaction broadcast, so that two requests never send
 * the same nonce, and a broadcast that fails gives its nonce back. `fn` gets the saved state; the store saves the
 * state it returns, if any.
 */
export interface NonceStore {
  locked<T>(
    relayer: Address,
    fn: (saved: NonceState | null) => Promise<{ save?: NonceState; value: T }>
  ): Promise<T>;
}

/**
 * How long the chain's nonce can stay behind ours without moving before the transactions in between are presumed
 * dropped. Monad makes a block every 0.4s, so 30s is ~75 blocks.
 */
export const STALL_MS = 30_000;
/** Attempts per transaction when the node says its nonce is taken. */
export const MAX_ATTEMPTS = 3;
/**
 * The saved state is stale (a restarted local chain, a restored database) rather than ahead with transactions in
 * flight when it's further ahead of the chain than a relayer ever has in flight, or when the chain's count went back
 * further than an RPC node lagging behind a load balancer would show.
 */
export const MAX_AHEAD = 64;
export const MAX_BACKWARDS = 16;

/**
 * The nonce to use, given the saved state and the chain's pending transaction count. The saved state is ahead of the
 * chain while transactions are in flight; the chain is ahead when the key was used elsewhere.
 */
export function nextNonce(
  saved: NonceState | null,
  chainNonce: number,
  now: number
): { nonce: number; state: NonceState } {
  if (
    !saved ||
    chainNonce >= saved.next ||
    saved.next - chainNonce > MAX_AHEAD ||
    saved.chainNonce - chainNonce > MAX_BACKWARDS
  ) {
    return { nonce: chainNonce, state: { next: chainNonce + 1, chainNonce, progressAt: now } };
  }
  if (chainNonce !== saved.chainNonce) {
    return { nonce: saved.next, state: { next: saved.next + 1, chainNonce, progressAt: now } };
  }
  if (now - saved.progressAt > STALL_MS) {
    // A transaction never made it, and every later one waits behind it: reuse the nonces from the chain's.
    return { nonce: chainNonce, state: { next: chainNonce + 1, chainNonce, progressAt: now } };
  }
  return { nonce: saved.next, state: { ...saved, next: saved.next + 1 } };
}

/**
 * Whether a broadcast failed because of its nonce: 'taken' if another transaction has it (nonce too low, or one with
 * the same nonce is pending), 'ahead' if there's a gap before it.
 */
export function nonceError(error: unknown): 'taken' | 'ahead' | null {
  const message = errorMessages(error).toLowerCase();
  // Nodes word these differently (geth, reth, anvil, Monad's RPC), and viem rewords some: match the known phrasings.
  if (
    /nonce too high|nonce is too high|nonce gap|higher than the next one expected/.test(message)
  ) {
    return 'ahead';
  }
  // "transaction underpriced" alone is about the fee, not the nonce: only a replacement means the nonce is taken.
  if (
    /nonce too low|nonce is too low|lower than the current nonce|already known|already imported|known transaction|replacement (transaction )?underpriced|already in (the )?(mem)?pool|nonce has already been used/.test(
      message
    )
  ) {
    return 'taken';
  }
  return null;
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  for (let e = error as { message?: unknown; details?: unknown; cause?: unknown } | undefined; e;) {
    messages.push(String(e.message ?? ''), String(e.details ?? ''));
    e = e.cause as typeof e;
  }
  return messages.join('\n');
}

type Outcome = { hash: Hex; nonce: number } | { error: unknown; retry: boolean };

/**
 * Picks the relayer's next nonce and broadcasts with it, holding the relayer's lock in between. A broadcast that
 * fails releases its nonce. One the node refuses for its nonce moves the state past it (or back to the chain's), and
 * is retried up to MAX_ATTEMPTS times.
 */
export async function sendWithNonce(params: {
  store: NonceStore;
  relayer: Address;
  /** The relayer's transaction count, pending transactions included where the node counts them. */
  chainNonce: () => Promise<number>;
  /** Signs and broadcasts with this nonce, returning the hash. */
  broadcast: (nonce: number) => Promise<Hex>;
  now?: () => number;
}): Promise<{ hash: Hex; nonce: number }> {
  const { store, relayer, chainNonce, broadcast, now = Date.now } = params;
  for (let attempt = 1; ; attempt++) {
    let sent: { hash: Hex; nonce: number } | undefined;
    let outcome: Outcome;
    try {
      outcome = await store.locked<Outcome>(relayer, async (saved) => {
        const { nonce, state } = nextNonce(saved, await chainNonce(), now());
        try {
          sent = { hash: await broadcast(nonce), nonce };
          return { save: state, value: sent };
        } catch (error) {
          const kind = nonceError(error);
          if (!kind) {
            return { value: { error, retry: false } };
          }
          const next = kind === 'taken' ? Math.max(state.chainNonce, nonce + 1) : state.chainNonce;
          return { save: { ...state, next }, value: { error, retry: attempt < MAX_ATTEMPTS } };
        }
      });
    } catch (error) {
      if (sent) {
        // Saving failed after the broadcast: the transaction is out. The next one hits its nonce and moves past it.
        console.error(`Couldn't save relayer ${relayer}'s nonce ${sent.nonce}`, error);
        return sent;
      }
      throw error;
    }
    if ('hash' in outcome) {
      return outcome;
    }
    if (!outcome.retry) {
      throw outcome.error;
    }
  }
}

/** Per process: correct for one instance (local development), not across serverless instances. */
export function memoryNonceStore(): NonceStore {
  const states = new Map<string, NonceState>();
  const queues = new Map<string, Promise<unknown>>();
  return {
    locked(relayer, fn) {
      const key = relayer.toLowerCase();
      const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
        const { save, value } = await fn(states.get(key) ?? null);
        if (save) {
          states.set(key, save);
        }
        return value;
      });
      queues.set(
        key,
        run.catch(() => {})
      );
      return run;
    },
  };
}

/**
 * Shared by every instance: a row per relayer, read and written in one transaction that holds an advisory lock on
 * it, broadcast included. A lock wait or a stuck holder (e.g. a frozen instance) times out instead of piling up.
 */
export function postgresNonceStore(sql: Sql, chainId: number): NonceStore {
  return {
    async locked<T>(
      relayer: Address,
      fn: (saved: NonceState | null) => Promise<{ save?: NonceState; value: T }>
    ): Promise<T> {
      await migrate(sql);
      const key = relayer.toLowerCase();
      try {
        // Wrapped: begin()'s result type unwraps arrays of promises, which a generic T can't go through.
        const { value } = await sql.begin(async (tx) => {
          await tx.unsafe(
            "SET LOCAL lock_timeout = '15s'; SET LOCAL idle_in_transaction_session_timeout = '30s'"
          );
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`nonce:${chainId}:${key}`}, 0))`;
          const [row] = await tx<{ next_nonce: bigint; chain_nonce: bigint; progress_at: Date }[]>`
            SELECT next_nonce, chain_nonce, progress_at FROM lens_web.relayer_nonces
            WHERE chain_id = ${chainId} AND relayer = ${key}
          `;
          const { save, value } = await fn(
            row
              ? {
                  next: Number(row.next_nonce),
                  chainNonce: Number(row.chain_nonce),
                  progressAt: row.progress_at.getTime(),
                }
              : null
          );
          if (save) {
            await tx`
              INSERT INTO lens_web.relayer_nonces (chain_id, relayer, next_nonce, chain_nonce, progress_at)
              VALUES (${chainId}, ${key}, ${save.next}, ${save.chainNonce}, ${new Date(save.progressAt)})
              ON CONFLICT (chain_id, relayer) DO UPDATE SET
                next_nonce = excluded.next_nonce,
                chain_nonce = excluded.chain_nonce,
                progress_at = excluded.progress_at
            `;
          }
          return { value };
        });
        return value;
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') {
          throw new HttpError(503, 'The app is busy, try again in a moment');
        }
        throw error;
      }
    },
  };
}
