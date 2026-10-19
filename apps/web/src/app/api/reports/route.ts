import { z } from 'zod';
import { isOwnedBy } from '@/lib/server/chain';
import { getSession } from '@/lib/server/session';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { assertAccess, auditModeration } from '@/lib/server/moderation';
import { database, migrate } from '@/lib/server/db';
import { rateLimit } from '@/lib/server/state';
import { notifyAdmins } from '@/lib/server/notifications-email';
import { parsePostId } from '@/lib/server/posts';

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const { owner, account } = await getSession();
    if (!owner || !account) throw new HttpError(401, 'Sign in with a Lens account to report');
    await assertAccess(owner, account);
    await rateLimit(`report:${account}`, 10, 3600_000);
    if (!(await isOwnedBy(account, owner)))
      throw new HttpError(403, 'Your wallet no longer owns this account');
    const body = z
      .object({
        targetType: z.enum(['post', 'account']),
        target: z.string().min(1).max(78),
        reason: z.enum(['spam', 'harassment', 'illegal', 'other']),
        details: z.string().trim().max(1000).default(''),
      })
      .strict()
      .parse(await request.json());
    if (body.targetType === 'post') parsePostId(body.target);
    else if (!/^0x[0-9a-fA-F]{40}$/.test(body.target))
      throw new HttpError(400, 'Invalid account address');
    const sql = database();
    if (!sql) throw new HttpError(503, 'Reports are not configured on this instance');
    await migrate(sql);
    const added = await sql.begin(async (tx) => {
      const rows =
        await tx`INSERT INTO lens_web.moderation_reports (reporter, target_type, target, reason, details)
        VALUES (${account.toLowerCase()}, ${body.targetType}, ${body.target.toLowerCase()}, ${body.reason}, ${body.details}) ON CONFLICT DO NOTHING RETURNING id::text`;
      if (rows.length)
        await auditModeration(tx, account, 'report.create', {
          reportId: rows[0]!.id,
          target: body.target.toLowerCase(),
          targetType: body.targetType,
        });
      return rows.length;
    });
    if (added)
      await notifyAdmins('new_reports', { count: added, page: '/admin/moderation' }).catch(() =>
        console.error('Could not notify moderators of new reports')
      );
    return Response.json({ reported: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
