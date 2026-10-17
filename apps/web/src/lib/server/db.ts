import postgres from 'postgres';
import { databaseUrl, numberEnv } from './env';

export type Sql = postgres.Sql<{ bigint: bigint }>;

/** Connects to Postgres. Several serverless instances each hold a pool, so keep it small (DATABASE_POOL_SIZE). */
export function connect(url: string, max = numberEnv('DATABASE_POOL_SIZE', 5)): Sql {
  return postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    // Unnamed statements work behind transaction poolers (PgBouncer, Supavisor) too.
    prepare: false,
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
}

let client: Sql | null | undefined;

/** The shared database when DATABASE_URL is set, null otherwise (local development keeps state in memory). */
export function database(): Sql | null {
  if (client === undefined) {
    const url = databaseUrl();
    client = url ? connect(url) : null;
  }
  return client;
}

// The app's tables live in their own schema, so they can share the indexer's database.
const SCHEMA = `
  CREATE SCHEMA IF NOT EXISTS lens_web;
  CREATE TABLE IF NOT EXISTS lens_web.relayer_nonces (
    chain_id integer NOT NULL,
    relayer text NOT NULL,
    next_nonce bigint NOT NULL,
    chain_nonce bigint NOT NULL,
    progress_at timestamptz NOT NULL,
    PRIMARY KEY (chain_id, relayer)
  );
  CREATE TABLE IF NOT EXISTS lens_web.rate_limit_hits (
    key text NOT NULL,
    at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_limit_hits_key_at ON lens_web.rate_limit_hits (key, at);
  CREATE TABLE IF NOT EXISTS lens_web.sponsored_gas (
    chain_id integer NOT NULL,
    hour timestamptz NOT NULL,
    gas bigint NOT NULL,
    PRIMARY KEY (chain_id, hour)
  );
  CREATE TABLE IF NOT EXISTS lens_web.likes (
    chain_id integer NOT NULL,
    account text NOT NULL,
    post_id text NOT NULL,
    post_author text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (chain_id, account, post_id)
  );
  CREATE INDEX IF NOT EXISTS likes_post_id ON lens_web.likes (chain_id, post_id);
  CREATE INDEX IF NOT EXISTS likes_post_author_created_at
    ON lens_web.likes (chain_id, post_author, created_at DESC);
`;

const migrations = new WeakMap<Sql, Promise<void>>();

/**
 * Creates the tables on first use, once per process. Instances can start together, and concurrent CREATE ... IF NOT
 * EXISTS can still collide, so they take a lock first.
 */
export function migrate(sql: Sql): Promise<void> {
  let migration = migrations.get(sql);
  if (!migration) {
    migration = sql
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended('lens_web:migrate', 0))`;
        await tx.unsafe(SCHEMA);
      })
      .then(() => undefined);
    // A failed migration (e.g. the database was down) is retried by the next request.
    migration.catch(() => migrations.delete(sql));
    migrations.set(sql, migration);
  }
  return migration;
}
