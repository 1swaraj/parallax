import { NextResponse } from 'next/server';
import { requireAdmin, adminDatabase } from '@/lib/server/admin';
import { handle } from '@/lib/server/guard';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handle(async () => {
    await requireAdmin('config');
    const before = new URL(request.url).searchParams.get('before');
    const cursor = before && /^[0-9]{1,18}$/.test(before) ? before : '9223372036854775807';
    const rows =
      await adminDatabase()`SELECT id::text, actor, action, details, created_at FROM lens_web.audit_log WHERE id < ${cursor}::bigint ORDER BY id DESC LIMIT 100`;
    return NextResponse.json(rows, { headers: { 'cache-control': 'no-store' } });
  });
}
