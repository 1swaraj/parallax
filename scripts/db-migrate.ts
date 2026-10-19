import { database, migrate } from '../apps/web/src/lib/server/db';
async function main() {
  const sql = database();
  if (!sql) throw new Error('Set DATABASE_URL or POSTGRES_URL');
  try {
    await migrate(sql);
    console.log('Database migrations applied.');
  } finally {
    await sql.end({ timeout: 2 });
  }
}
main().catch(() => {
  console.error('Database migration failed. Check the connection and schema permissions.');
  process.exitCode = 1;
});
