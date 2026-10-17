import { NextResponse } from 'next/server';
import { checkHealth } from '@/lib/server/health';

export const dynamic = 'force-dynamic';

/**
 * For uptime monitors: 200 when the RPC, the relayers (funded and allowlisted), the indexer, the database and the gas
 * budget are fine, 503 with the problems otherwise. Pausing (RELAY_PAUSED) is deliberate, so it shows but stays 200.
 */
export async function GET() {
  const health = await checkHealth();
  return NextResponse.json(health, {
    status: health.healthy ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
