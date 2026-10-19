import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, adminDatabase } from '@/lib/server/admin';
import { assertSameOrigin, handle } from '@/lib/server/guard';
export async function PUT(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    assertSameOrigin(request);
    const { email, alerts } = z
      .object({ email: z.union([z.string().email(), z.literal('')]), alerts: z.boolean() })
      .parse(await request.json());
    await adminDatabase().begin(async (tx) => {
      await tx`UPDATE lens_web.instance_admins SET email = ${email || null}, alerts = ${alerts} WHERE address = ${admin.address}`;
      await tx`INSERT INTO lens_web.audit_log (actor, action) VALUES (${admin.address}, 'alerts.preferences')`;
    });
    return NextResponse.json({ saved: true });
  });
}
