import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setupStatus, claimOwner } from '@/lib/server/setup';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';
import { adminDatabase, requireAdmin } from '@/lib/server/admin';
import { rateLimit } from '@/lib/server/state';
import { clientIpKey } from '@/lib/server/requests';
export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    const status = await setupStatus();
    if (status.completed) throw new HttpError(404, 'Not found');
    if (status.claimed && (await requireAdmin()).role !== 'owner')
      throw new HttpError(404, 'Not found');
    return NextResponse.json(status, { headers: { 'cache-control': 'no-store' } });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const status = await setupStatus();
    if (status.completed) throw new HttpError(404, 'Not found');
    const session = await getSession();
    if (!session.owner) throw new HttpError(401, 'Sign in with your wallet first');
    await rateLimit(`setup:${clientIpKey(request)}`, 10, 60_000);
    const { token } = z.object({ token: z.string().min(1).max(512) }).parse(await request.json());
    await claimOwner(adminDatabase(), session.owner, token);
    return NextResponse.json({ claimed: true });
  });
}
export async function PUT(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const status = await setupStatus();
    if (admin.role !== 'owner' || !status.claimed || status.completed)
      throw new HttpError(404, 'Not found');
    assertSameOrigin(request);
    const sql = adminDatabase();
    await sql.begin(async (tx) => {
      await tx`UPDATE lens_web.instance_setup SET completed_at = now() WHERE id = 1 AND completed_at IS NULL`;
      await tx`INSERT INTO lens_web.audit_log (actor, action) VALUES (${admin.address}, 'setup.complete')`;
    });
    return NextResponse.json({ completed: true });
  });
}
