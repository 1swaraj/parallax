// Same checks as /api/health; no HTTP token needed when run in the operator's environment.
import { database } from '../apps/web/src/lib/server/db';
import { checkHealth } from '../apps/web/src/lib/server/health';

async function main() {
  try {
    const health = await checkHealth();
    console.log(JSON.stringify(health, null, 2));
    process.exitCode = health.healthy ? 0 : 1;
  } finally {
    await database()?.end({ timeout: 2 });
  }
}
main().catch(() => {
  console.error('Doctor could not load the instance settings. Check the environment variables.');
  process.exitCode = 1;
});
