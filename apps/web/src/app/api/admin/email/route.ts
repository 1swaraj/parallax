import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, adminDatabase } from '@/lib/server/admin';
import { assertSameOrigin, handle } from '@/lib/server/guard';
import { sendEmail, checkEmailDomain } from '@/lib/server/email';
import { rateLimit } from '@/lib/server/state';
export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin('config');
    assertSameOrigin(request);
    const input = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('test'), to: z.string().email() }),
        z.object({ action: z.literal('domain') }),
      ])
      .parse(await request.json());
    await rateLimit(`admin-email:${admin.address}`, 5, 60_000);
    // Record the attempt before the provider call, including failed sends.
    await adminDatabase()`INSERT INTO lens_web.audit_log (actor, action) VALUES (${admin.address}, ${`email.${input.action}`})`;
    if (input.action === 'domain') return NextResponse.json(await checkEmailDomain());
    await sendEmail({
      to: input.to,
      subject: 'Test email',
      text: 'Your instance can send email through Resend.',
    });
    return NextResponse.json({ sent: true });
  });
}
