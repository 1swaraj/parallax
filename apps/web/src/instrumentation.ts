export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DATABASE_URL) {
    const { database, migrate } = await import('./lib/server/db');
    await migrate(database()!);
    const { setupStatus } = await import('./lib/server/setup');
    await setupStatus();
  }
}
