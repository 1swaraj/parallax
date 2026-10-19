// Uses a running loopback chain + indexer and two disposable Postgres databases. Anvil keys only.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployInstanceRouter, getDeployment } from '../packages/protocol/src';
import { localTestChain as chain } from '../packages/protocol/test/local-chain';
import { connect, migrate } from '../apps/web/src/lib/server/db';

const OWNER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEYS = [
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
] as const;
const children: ChildProcess[] = [];
const cleanup = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {}
  }
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function main() {
  const databases = [process.env.INSTANCE_ONE_DATABASE_URL, process.env.INSTANCE_TWO_DATABASE_URL];
  if (databases.some((db) => !db))
    throw new Error(
      'Set INSTANCE_ONE_DATABASE_URL and INSTANCE_TWO_DATABASE_URL to disposable databases'
    );
  if (
    new URL(databases[0]!).pathname === new URL(databases[1]!).pathname &&
    new URL(databases[0]!).host === new URL(databases[1]!).host
  )
    throw new Error('Use two different databases');
  const transport = http(chain.rpcUrls.default.http[0]);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(OWNER) });
  mkdirSync('.context', { recursive: true });
  try {
    for (let i = 0; i < 2; i++) {
      const sql = connect(databases[i]!);
      try {
        await migrate(sql);
      } finally {
        await sql.end();
      }
      const { router } = await deployInstanceRouter({
        client,
        wallet,
        referenceRouter: getDeployment(chain.id).contracts.SponsorRouter,
        relayers: [privateKeyToAccount(KEYS[i]!).address],
      });
      const port = 3100 + i;
      const log = openSync(`.context/instance-${i + 1}.log`, 'w');
      const child = spawn(
        'pnpm',
        [
          '--filter',
          '@lens-monad/web',
          'exec',
          'next',
          'dev',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        {
          detached: true,
          stdio: ['ignore', log, log],
          env: {
            ...process.env,
            NEXT_PUBLIC_CHAIN_ID: String(chain.id),
            NEXT_PUBLIC_RPC_URL: chain.rpcUrls.default.http[0],
            RPC_URL: chain.rpcUrls.default.http[0],
            NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
            INDEXER_URL: process.env.INDEXER_URL ?? 'http://127.0.0.1:42069',
            DATABASE_URL: databases[i]!,
            RELAYER_PRIVATE_KEYS: KEYS[i]!,
            SPONSOR_ROUTER_ADDRESS: router,
            APP_NAME: i ? 'Instance Two' : 'Instance One',
            SESSION_SECRET: 'test-instance-session-secret-0123456789012345',
            HEALTH_TOKEN: 'instances-test-health',
            SPONSOR_GAS_BUDGET_PER_HOUR: '500000000',
            RELAY_PAUSED: 'false',
            NEXT_DIST_DIR: `.next-instance-${i + 1}`,
          },
        }
      );
      closeSync(log);
      children.push(child);
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (child.exitCode !== null)
          throw new Error(`Web server ${i + 1} exited; see .context/instance-${i + 1}.log`);
        const response = await fetch(`http://127.0.0.1:${port}/api/instance`).catch(() => null);
        if (response?.ok) break;
        if (Date.now() > deadline) throw new Error('Web server startup timed out');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const test = spawn(
      'pnpm',
      ['--filter', '@lens-monad/web', 'exec', 'vitest', 'run', 'test/instances.e2e.test.ts'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_CHAIN_ID: String(chain.id),
          APP_URL: 'http://127.0.0.1:3100',
          INSTANCE_TWO_URL: 'http://127.0.0.1:3101',
          HEALTH_TOKEN: 'instances-test-health',
        },
      }
    );
    process.exitCode = await new Promise<number>((resolve) =>
      test.once('exit', (code) => resolve(code ?? 1))
    );
  } finally {
    cleanup();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
