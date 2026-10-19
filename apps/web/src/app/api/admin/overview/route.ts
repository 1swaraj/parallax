import { NextResponse } from 'next/server';
import { requireAdmin, adminDatabase } from '@/lib/server/admin';
import { handle } from '@/lib/server/guard';
import { checkHealth } from '@/lib/server/health';
export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    await requireAdmin();
    const [health, [counts]] = await Promise.all([
      checkHealth(),
      adminDatabase()`SELECT count(*)::int AS count FROM lens_web.signups WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    ]);
    return NextResponse.json(
      { ...health, signupsToday: counts!.count },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
