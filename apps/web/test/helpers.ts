import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { connect, type Sql } from '../src/lib/server/db';

/**
 * Postgres for the shared implementations' tests, e.g. `TEST_DATABASE_URL=postgres://localhost:5433/postgres`. They
 * create the lens_web schema there, and use random keys, relayers and chain ids, so runs don't see each other.
 *
 * PGlite's socket server (pglite-server) multiplexes its connections onto one session, where concurrent statements
 * from different connections can mix: with it, run `TEST_DATABASE_POOL_SIZE=1 … test --no-file-parallelism`.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function testDatabase(): Sql {
  return connect(TEST_DATABASE_URL!, Number(process.env.TEST_DATABASE_POOL_SIZE ?? 10));
}

export function randomAddress() {
  return privateKeyToAddress(generatePrivateKey());
}

export function randomChainId() {
  return 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
}

/** A clock tests move by hand. */
export function fakeClock(start = Date.UTC(2026, 9, 18, 12, 0, 0)) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
