// The relayer nonce allocator, with the in-memory and the Postgres store (when TEST_DATABASE_URL is set), against a
// fake node; and how relayers are picked.

import { keccak256, toHex, type Address, type Hex } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../src/lib/server/db';
import { HttpError } from '../src/lib/server/guard';
import {
  MAX_AHEAD,
  MAX_ATTEMPTS,
  MAX_BACKWARDS,
  memoryNonceStore,
  nextNonce,
  nonceError,
  postgresNonceStore,
  sendWithNonce,
  STALL_MS,
  type NonceStore,
} from '../src/lib/server/nonces';
import { relayerIndex } from '../src/lib/server/relayers';
import {
  fakeClock,
  randomAddress,
  randomChainId,
  TEST_DATABASE_URL,
  testDatabase,
} from './helpers';

/**
 * A node like Monad's: the transaction count only moves when transactions are mined, it refuses nonces below it,
 * and a nonce already in its pool.
 */
function fakeNode() {
  const pool = new Map<number, Hex>();
  const node = {
    mined: 0,
    pool,
    attempts: 0,
    failNext: null as Error | null,
    async count() {
      return node.mined;
    },
    async broadcast(nonce: number): Promise<Hex> {
      node.attempts++;
      // Others take a moment, so concurrent senders really overlap.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
      if (node.failNext) {
        const error = node.failNext;
        node.failNext = null;
        throw error;
      }
      if (nonce < node.mined) {
        throw new Error('nonce too low');
      }
      if (pool.has(nonce)) {
        throw new Error('replacement transaction underpriced');
      }
      const hash = keccak256(toHex(`${nonce}:${Math.random()}`));
      pool.set(nonce, hash);
      return hash;
    },
    /** Mines the pool's transactions that follow the chain's nonce. */
    mine() {
      while (pool.has(node.mined)) {
        pool.delete(node.mined);
        node.mined++;
      }
    },
  };
  return node;
}

let sql: Sql | undefined;
afterAll(() => sql?.end());

const stores: { name: string; enabled: boolean; create: () => NonceStore }[] = [
  { name: 'memory', enabled: true, create: memoryNonceStore },
  {
    name: 'postgres',
    enabled: !!TEST_DATABASE_URL,
    create: () => postgresNonceStore(() => (sql ??= testDatabase()), randomChainId()),
  },
];

describe.each(stores)('nonce allocation, $name store', ({ enabled, create }) => {
  function setup() {
    const store = create();
    const node = fakeNode();
    const clock = fakeClock();
    const relayer = randomAddress();
    const send = () =>
      sendWithNonce({
        store,
        relayer,
        chainNonce: node.count,
        broadcast: node.broadcast,
        now: clock.now,
      });
    return { store, node, clock, relayer, send };
  }

  it.skipIf(!enabled)('hands out consecutive nonces, ahead of the chain', async () => {
    const { node, send } = setup();
    const nonces = [];
    for (let i = 0; i < 5; i++) {
      nonces.push((await send()).nonce);
    }
    expect(nonces).toEqual([0, 1, 2, 3, 4]);
    expect(node.mined).toBe(0);
    node.mine();
    expect(node.mined).toBe(5);
    expect((await send()).nonce).toBe(5);
  });

  it.skipIf(!enabled)('never gives two concurrent senders the same nonce', async () => {
    const { node, send } = setup();
    const sent = await Promise.all(Array.from({ length: 25 }, send));
    expect(sent.map((s) => s.nonce).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i)
    );
    // Every broadcast went through the first time: no collisions to recover from.
    expect(node.attempts).toBe(25);
    node.mine();
    expect(node.mined).toBe(25);
  });

  it.skipIf(!enabled)('gives back the nonce of a broadcast that failed', async () => {
    const { node, send } = setup();
    await send();
    node.failNext = new Error('insufficient funds for gas * price + value');
    await expect(send()).rejects.toThrow('insufficient funds');
    expect((await send()).nonce).toBe(1);
  });

  it.skipIf(!enabled)('catches up when the key was used elsewhere', async () => {
    const { node, send } = setup();
    await send();
    node.mine();
    node.mined = 10;
    expect((await send()).nonce).toBe(10);
  });

  it.skipIf(!enabled)(
    'moves past a nonce that another transaction holds, and retries',
    async () => {
      const { node, send } = setup();
      // Another sender of the key put nonce 0 in the pool, unbeknownst to the store.
      node.pool.set(0, '0x00');
      expect((await send()).nonce).toBe(1);
      expect(node.attempts).toBe(2);
      expect((await send()).nonce).toBe(2);
    }
  );

  it.skipIf(!enabled)(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
    const { node, send } = setup();
    for (let i = 0; i < MAX_ATTEMPTS; i++) node.pool.set(i, '0x00');
    await expect(send()).rejects.toThrow('replacement transaction underpriced');
    expect(node.attempts).toBe(MAX_ATTEMPTS);
    // The state moved past them, so the next transaction goes.
    expect((await send()).nonce).toBe(MAX_ATTEMPTS);
  });

  it.skipIf(!enabled)('resyncs to the chain when a nonce gap stalls it', async () => {
    const { node, clock, send } = setup();
    await send();
    await send();
    await send();
    // The node dropped nonce 0, so 1 and 2 wait behind it, and the chain doesn't move.
    node.pool.delete(0);
    clock.advance(5_000);
    expect((await send()).nonce).toBe(3);
    clock.advance(STALL_MS);
    expect((await send()).nonce).toBe(0);
    // The gap is filled: the transactions waiting behind it go in, and the state follows the chain again.
    node.mine();
    expect(node.mined).toBe(4);
    expect((await send()).nonce).toBe(4);
  });

  it.skipIf(!enabled)(
    'returns a broadcast transaction even if saving its nonce fails',
    async () => {
      const { store, node, relayer } = setup();
      const failingSave: NonceStore = {
        async locked(r, fn) {
          await store.locked(r, fn);
          throw new Error('connection lost');
        },
      };
      const sent = await sendWithNonce({
        store: failingSave,
        relayer,
        chainNonce: node.count,
        broadcast: node.broadcast,
      });
      expect(node.pool.get(sent.nonce)).toBe(sent.hash);
    }
  );

  it.skipIf(!enabled)('keeps relayers apart', async () => {
    const store = create();
    const [a, b] = [fakeNode(), fakeNode()];
    const [relayerA, relayerB] = [randomAddress(), randomAddress()];
    const sends = Array.from({ length: 10 }, (_, i) =>
      i % 2
        ? sendWithNonce({ store, relayer: relayerA, chainNonce: a.count, broadcast: a.broadcast })
        : sendWithNonce({ store, relayer: relayerB, chainNonce: b.count, broadcast: b.broadcast })
    );
    await Promise.all(sends);
    expect([...a.pool.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...b.pool.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres nonce store, within an instance', () => {
  /** A request that takes `relayer`'s lock and holds it until `done` resolves. */
  function hold(store: NonceStore, relayer: Address, done: Promise<void>) {
    return store.locked(relayer, async () => {
      await done;
      return { value: null };
    });
  }

  it("keeps requests queued on a busy relayer from taking another relayer's connection", async () => {
    // One connection per relayer, as nonceDatabase() sizes it.
    const pool = connect(TEST_DATABASE_URL!, 2);
    try {
      const store = postgresNonceStore(() => pool, randomChainId());
      const [busy, other] = [randomAddress(), randomAddress()];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      const queued = Array.from({ length: 4 }, () => hold(store, busy, done));
      const otherSent = await store.locked(other, async () => ({ value: 'sent' }));
      expect(otherSent).toBe('sent');
      finish();
      await Promise.all(queued);
    } finally {
      await pool.end();
    }
  });

  it('gives up with a 503 when the relayer stays busy', async () => {
    const pool = connect(TEST_DATABASE_URL!, 2);
    try {
      const store = postgresNonceStore(() => pool, randomChainId(), 200);
      const relayer = randomAddress();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      const holder = hold(store, relayer, done);
      const waiter = store.locked(relayer, async () => ({ value: 'late' }));
      await expect(waiter).rejects.toBeInstanceOf(HttpError);
      await expect(waiter).rejects.toMatchObject({ status: 503 });
      finish();
      await holder;
      // The queue moves on past the request that gave up.
      expect(await store.locked(relayer, async () => ({ value: 'next' }))).toBe('next');
    } finally {
      await pool.end();
    }
  });
});

describe('nextNonce', () => {
  it('drops a stale state at once (a restarted chain, a restored database)', () => {
    const now = 1_000_000;
    const progressAt = now - 1_000;
    // Further ahead than transactions in flight explain.
    expect(nextNonce({ next: 6 + MAX_AHEAD, chainNonce: 5, progressAt }, 5, now).nonce).toBe(5);
    expect(nextNonce({ next: 5 + MAX_AHEAD, chainNonce: 5, progressAt }, 5, now).nonce).toBe(
      5 + MAX_AHEAD
    );
    // The chain's count went back: a new chain, unless it's a node lagging by a few.
    const saved = { next: 141, chainNonce: 140, progressAt };
    expect(nextNonce(saved, 140 - MAX_BACKWARDS - 1, now).nonce).toBe(140 - MAX_BACKWARDS - 1);
    expect(nextNonce(saved, 140 - MAX_BACKWARDS, now).nonce).toBe(141);
  });

  it("doesn't take an idle relayer for a stalled one", () => {
    // Idle for an hour, the chain caught up: a burst starts.
    const start = 3_600_000;
    const first = nextNonce({ next: 7, chainNonce: 7, progressAt: 0 }, 7, start);
    expect(first.nonce).toBe(7);
    const second = nextNonce(first.state, 7, start + 100);
    expect(second.nonce).toBe(8);
  });
});

describe('nonceError', () => {
  it('tells taken nonces from gaps, and ignores the rest', () => {
    const rpcError = (details: string) =>
      Object.assign(new Error('RPC Request failed.'), { details, cause: undefined });
    expect(nonceError(rpcError('nonce too low'))).toBe('taken');
    expect(nonceError(rpcError('already known'))).toBe('taken');
    expect(nonceError(rpcError('replacement transaction underpriced'))).toBe('taken');
    expect(nonceError(new Error('wrapped', { cause: rpcError('Nonce too low') }))).toBe('taken');
    expect(nonceError(rpcError('nonce too high'))).toBe('ahead');
    expect(nonceError(rpcError('transaction underpriced'))).toBeNull();
    expect(nonceError(rpcError('insufficient funds for gas * price + value'))).toBeNull();
  });
});

describe('relayerIndex', () => {
  it('is deterministic, ignores checksum casing, and spreads accounts', () => {
    const account = randomAddress();
    expect(relayerIndex(account, 3)).toBe(relayerIndex(account.toLowerCase() as Address, 3));
    expect(relayerIndex(account, 1)).toBe(0);
    const counts = [0, 0, 0];
    for (let i = 0; i < 3_000; i++) {
      counts[relayerIndex(randomAddress(), 3)]!++;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1_150);
    }
  });
});
