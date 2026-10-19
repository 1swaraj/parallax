import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, adminDatabase, resolveWallet } from '@/lib/server/admin';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    await requireAdmin('team');
    return NextResponse.json(
      await adminDatabase()`SELECT address, role, email, alerts FROM lens_web.instance_admins ORDER BY created_at`,
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
const Member = z.object({
  address: z.string().min(1).max(128),
  role: z.enum(['admin', 'moderator']).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  alerts: z.boolean().optional(),
});
export async function PUT(request: Request) {
  return handle(async () => {
    const actor = await requireAdmin('team');
    assertSameOrigin(request);
    const input = Member.parse(await request.json());
    const address = (await resolveWallet(input.address)).toLowerCase();
    const sql = adminDatabase();
    await sql.begin(async (tx) => {
      if (address === actor.address) {
        await tx`UPDATE lens_web.instance_admins SET email = CASE WHEN ${input.email !== undefined} THEN ${input.email || null} ELSE email END, alerts = CASE WHEN ${input.alerts !== undefined} THEN ${input.alerts ?? false} ELSE alerts END WHERE address = ${address}`;
      } else {
        if (!input.role) throw new HttpError(400, 'Choose admin or moderator');
        await tx`INSERT INTO lens_web.instance_admins (address, role, email, alerts) VALUES (${address}, ${input.role}, ${input.email || null}, ${input.alerts ?? false}) ON CONFLICT (address) DO UPDATE SET role = excluded.role, email = CASE WHEN ${input.email !== undefined} THEN excluded.email ELSE lens_web.instance_admins.email END, alerts = CASE WHEN ${input.alerts !== undefined} THEN excluded.alerts ELSE lens_web.instance_admins.alerts END WHERE lens_web.instance_admins.role <> 'owner'`;
      }
      await tx`INSERT INTO lens_web.audit_log (actor, action, details) VALUES (${actor.address}, 'team.update', ${tx.json({ address, role: input.role ?? actor.role })})`;
    });
    return NextResponse.json({ saved: true });
  });
}
export async function DELETE(request: Request) {
  return handle(async () => {
    const actor = await requireAdmin('team');
    assertSameOrigin(request);
    const { address: value } = Member.pick({ address: true }).parse(await request.json());
    const address = (await resolveWallet(value)).toLowerCase();
    if (address === actor.address)
      throw new HttpError(400, 'The owner cannot be removed; use admin:reset-owner');
    const sql = adminDatabase();
    await sql.begin(async (tx) => {
      await tx`DELETE FROM lens_web.instance_admins WHERE address = ${address} AND role <> 'owner'`;
      await tx`INSERT INTO lens_web.audit_log (actor, action, details) VALUES (${actor.address}, 'team.remove', ${tx.json({ address })})`;
    });
    return NextResponse.json({ removed: true });
  });
}
