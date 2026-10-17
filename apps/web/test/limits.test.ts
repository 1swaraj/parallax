// The rate limiter and the gas budget, in memory and in Postgres (when TEST_DATABASE_URL is set).

import { afterAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/server/db';
import {
  memoryGasBudget,
  memoryRateLimiter,
  postgresGasBudget,
  postgresRateLimiter,
  type GasBudget,
  type RateLimiter,
} from '../src/lib/server/limits';
import { fakeClock, randomChainId, TEST_DATABASE_URL, testDatabase } from './helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let sql: Sql | undefined;
function database() {
  sql ??= testDatabase();
  return sql;
}
afterAll(() => sql?.end());

const implementations = [
  {
    name: 'memory',
    enabled: true,
    rateLimiter: (now: () => number) => memoryRateLimiter(now),
    gasBudget: (now: () => number) => memoryGasBudget(now),
  },
  {
    name: 'postgres',
    enabled: !!TEST_DATABASE_URL,
    rateLimiter: (now: () => number) => postgresRateLimiter(database(), now),
    gasBudget: (now: () => number) => postgresGasBudget(database(), randomChainId(), now),
  },
];

describe.each(implementations)('$name rate limiter', ({ enabled, rateLimiter }) => {
  const key = () => `test:${Math.random()}`;

  it.skipIf(!enabled)('allows `limit` hits per window, per key', async () => {
    const clock = fakeClock();
    const limiter: RateLimiter = rateLimiter(clock.now);
    const [a, b] = [key(), key()];
    for (let i = 0; i < 3; i++) {
      expect(await limiter.hit(a, 3, MINUTE)).toBe(true);
    }
    expect(await limiter.hit(a, 3, MINUTE)).toBe(false);
    expect(await limiter.hit(b, 3, MINUTE)).toBe(true);
  });

  it.skipIf(!enabled)('slides: hits leave the window one by one', async () => {
    const clock = fakeClock();
    const limiter = rateLimiter(clock.now);
    const k = key();
    expect(await limiter.hit(k, 2, MINUTE)).toBe(true);
    clock.advance(30_000);
    expect(await limiter.hit(k, 2, MINUTE)).toBe(true);
    expect(await limiter.hit(k, 2, MINUTE)).toBe(false);
    // The first hit is a minute old: one slot frees up, not two.
    clock.advance(30_000);
    expect(await limiter.hit(k, 2, MINUTE)).toBe(true);
    expect(await limiter.hit(k, 2, MINUTE)).toBe(false);
    // Refused hits don't count.
    clock.advance(30_001);
    expect(await limiter.hit(k, 2, MINUTE)).toBe(true);
  });

  it.skipIf(!enabled)('never lets concurrent hits past the limit', async () => {
    const limiter = rateLimiter(fakeClock().now);
    const k = key();
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.hit(k, 5, HOUR)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});

describe.each(implementations)('$name gas budget', ({ enabled, gasBudget }) => {
  it.skipIf(!enabled)('reserves until the hour is spent, then refuses', async () => {
    const clock = fakeClock();
    const budget: GasBudget = gasBudget(clock.now);
    expect(await budget.reserve(600n, 1_000n)).not.toBeNull();
    expect(await budget.reserve(500n, 1_000n)).toBeNull();
    expect(await budget.reserve(400n, 1_000n)).not.toBeNull();
    expect(await budget.reserve(1n, 1_000n)).toBeNull();
    expect(await budget.usedThisHour()).toBe(1_000n);
    // A transaction bigger than the whole budget never goes.
    expect(await gasBudget(clock.now).reserve(1_001n, 1_000n)).toBeNull();
  });

  it.skipIf(!enabled)('settles reservations to the gas used, and frees unsent ones', async () => {
    const clock = fakeClock();
    const budget = gasBudget(clock.now);
    const sent = (await budget.reserve(1_100n, 2_000n))!;
    const failed = (await budget.reserve(800n, 2_000n))!;
    expect(await budget.reserve(200n, 2_000n)).toBeNull();
    await budget.settle(sent, 1_000n);
    await budget.settle(failed, 0n);
    expect(await budget.usedThisHour()).toBe(1_000n);
    expect(await budget.reserve(1_000n, 2_000n)).not.toBeNull();
  });

  it.skipIf(!enabled)('starts over every clock hour, and settles in the right one', async () => {
    const clock = fakeClock();
    const budget = gasBudget(clock.now);
    const reservation = (await budget.reserve(1_000n, 1_000n))!;
    clock.advance(HOUR);
    expect(await budget.usedThisHour()).toBe(0n);
    expect(await budget.reserve(1_000n, 1_000n)).not.toBeNull();
    // Settling the previous hour's transaction leaves this hour alone.
    await budget.settle(reservation, 900n);
    expect(await budget.usedThisHour()).toBe(1_000n);
  });

  it.skipIf(!enabled)('never lets concurrent reservations past the budget', async () => {
    const budget = gasBudget(fakeClock().now);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => budget.reserve(100n, 1_000n))
    );
    expect(results.filter((r) => r !== null)).toHaveLength(10);
    expect(await budget.usedThisHour()).toBe(1_000n);
  });
});
