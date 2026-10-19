import { NextResponse } from 'next/server';
import { findAdmin } from '@/lib/server/admin';
import { canSeeHealthDetails, checkHealth } from '@/lib/server/health';

export const dynamic = 'force-dynamic';

/**
 * For uptime monitors: 200 when the RPC, the relayers (funded and allowlisted), the indexer, the database and the gas
 * budget are fine, 503 otherwise. Pausing (RELAY_PAUSED) is deliberate, so it shows but stays 200. Everyone gets the
 * status; the details (relayers, balances, gas, problems) take `Authorization: Bearer <HEALTH_TOKEN>`.
 */
export async function GET(request: Request) {
  const health = await checkHealth();
  const status = health.healthy ? 'ok' : 'degraded';
  return NextResponse.json(
    canSeeHealthDetails(request.headers.get('authorization')) ||
      !!(await findAdmin().catch(() => null))
      ? { status, ...health }
      : { status },
    { status: health.healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } }
  );
}
