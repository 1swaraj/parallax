import { NextResponse } from 'next/server';
import { z } from 'zod';
import { database } from '@/lib/server/db';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';
import { subscribeEmail, emailAvailable } from '@/lib/server/notifications-email';
import { rateLimit } from '@/lib/server/state';
import { clientIpKey } from '@/lib/server/requests';
export const dynamic = 'force-dynamic';
async function emailOwner() {
  const session = await getSession();
  if (!session.owner) throw new HttpError(401, 'Sign in first');
  return session.owner.toLowerCase();
}
export async function GET() {
  return handle(async () => {
    const owner = await emailOwner();
    if (!(await emailAvailable())) throw new HttpError(404, 'Not found');
    const [row] =
      await database()!`SELECT email, frequency, verified FROM lens_web.email_subscriptions WHERE owner = ${owner}`;
    return NextResponse.json(row ?? null, { headers: { 'cache-control': 'no-store' } });
  });
}
export async function PUT(request: Request) {
  return handle(async () => {
    const owner = await emailOwner();
    assertSameOrigin(request);
    await rateLimit(`email:${owner}`, 3, 3_600_000);
    await rateLimit(`email-ip:${clientIpKey(request)}`, 10, 3_600_000);
    const input = z
      .object({ email: z.string().email().max(320), frequency: z.enum(['daily', 'weekly']) })
      .parse(await request.json());
    await subscribeEmail(owner, input.email, input.frequency);
    return NextResponse.json({ sent: true });
  });
}
export async function DELETE(request: Request) {
  return handle(async () => {
    const owner = await emailOwner();
    assertSameOrigin(request);
    const sql = database();
    if (sql) await sql`DELETE FROM lens_web.email_subscriptions WHERE owner = ${owner}`;
    return NextResponse.json({ removed: true });
  });
}
