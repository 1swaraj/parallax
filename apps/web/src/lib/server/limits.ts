import { migrate, type Sql } from './db';

const HOUR_MS = 60 * 60 * 1000;
// Rate limit windows are at most an hour; older hits are swept now and then.
const SWEEP_AFTER_MS = 24 * HOUR_MS;

/** Sliding-window rate limiter: `hit` records a hit and returns true, or returns false if `limit` was reached. */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** What one transaction reserved from an hour's gas budget. */
export type GasReservation = { hour: number; gas: bigint };

/**
 * The relayers' gas, per clock hour. Transactions reserve their gas limit before they're sent, so concurrent requests
 * can't overshoot the budget, then settle it to the receipt's gasUsed.
 */
export interface GasBudget {
  /** Reserves `gas` in the current hour, or returns null if the hour's total would go over `limit`. */
  reserve(gas: bigint, limit: bigint): Promise<GasReservation | null>;
  /** Replaces a reservation by the gas the transaction used (0 if it was never sent). */
  settle(reservation: GasReservation, used: bigint): Promise<void>;
  usedThisHour(): Promise<bigint>;
}

function hourOf(time: number) {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

/** Per process: enough for local development, but each serverless instance would get its own limits. */
export function memoryRateLimiter(now = Date.now): RateLimiter {
  const windows = new Map<string, number[]>();
  return {
    async hit(key, limit, windowMs) {
      const time = now();
      const recent = (windows.get(key) ?? []).filter((at) => time - at < windowMs);
      if (recent.length >= limit) {
        windows.set(key, recent);
        return false;
      }
      recent.push(time);
      windows.set(key, recent);
      return true;
    },
  };
}

export function memoryGasBudget(now = Date.now): GasBudget {
  const hours = new Map<number, bigint>();
  return {
    async reserve(gas, limit) {
      const hour = hourOf(now());
      const used = hours.get(hour) ?? 0n;
      if (used + gas > limit) {
        return null;
      }
      hours.set(hour, used + gas);
      return { hour, gas };
    },
    async settle({ hour, gas }, used) {
      const total = (hours.get(hour) ?? 0n) - gas + used;
      hours.set(hour, total > 0n ? total : 0n);
    },
    async usedThisHour() {
      return hours.get(hourOf(now())) ?? 0n;
    },
  };
}

/**
 * Shared by every instance. A per-key advisory lock serializes the count and the insert, so concurrent requests on
 * several instances can't all slip under the limit.
 */
export function postgresRateLimiter(sql: Sql, now = Date.now): RateLimiter {
  return {
    async hit(key, limit, windowMs) {
      await migrate(sql);
      const time = now();
      const allowed = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`rate:${key}`}, 0))`;
        await tx`
          DELETE FROM lens_web.rate_limit_hits WHERE key = ${key} AND at <= ${new Date(time - windowMs)}
        `;
        const [{ count }] = await tx<[{ count: number }]>`
          SELECT count(*)::int AS count FROM lens_web.rate_limit_hits WHERE key = ${key}
        `;
        if (count >= limit) {
          return false;
        }
        await tx`INSERT INTO lens_web.rate_limit_hits (key, at) VALUES (${key}, ${new Date(time)})`;
        return true;
      });
      // Keys that aren't hit again (an IP, a throwaway wallet) would keep their rows otherwise.
      if (Math.random() < 0.01) {
        await sql`DELETE FROM lens_web.rate_limit_hits WHERE at < ${new Date(time - SWEEP_AFTER_MS)}`;
      }
      return allowed;
    },
  };
}

/** The hourly totals stay in lens_web.sponsored_gas, a record of what the relayers spent. */
export function postgresGasBudget(sql: Sql, chainId: number, now = Date.now): GasBudget {
  return {
    async reserve(gas, limit) {
      await migrate(sql);
      if (gas > limit) {
        return null;
      }
      const hour = hourOf(now());
      // One statement: the row lock makes concurrent reservations add up one after the other.
      const rows = await sql`
        INSERT INTO lens_web.sponsored_gas AS budget (chain_id, hour, gas)
        VALUES (${chainId}, ${new Date(hour)}, ${gas})
        ON CONFLICT (chain_id, hour) DO UPDATE SET gas = budget.gas + excluded.gas
        WHERE budget.gas + excluded.gas <= ${limit}
        RETURNING budget.gas
      `;
      return rows.length > 0 ? { hour, gas } : null;
    },
    async settle({ hour, gas }, used) {
      await migrate(sql);
      await sql`
        UPDATE lens_web.sponsored_gas SET gas = greatest(gas - ${gas} + ${used}, 0)
        WHERE chain_id = ${chainId} AND hour = ${new Date(hour)}
      `;
    },
    async usedThisHour() {
      await migrate(sql);
      const [row] = await sql<{ gas: bigint }[]>`
        SELECT gas FROM lens_web.sponsored_gas
        WHERE chain_id = ${chainId} AND hour = ${new Date(hourOf(now()))}
      `;
      return row?.gas ?? 0n;
    },
  };
}
