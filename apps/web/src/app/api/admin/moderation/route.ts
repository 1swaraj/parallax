import { z } from 'zod';
import { isAddress } from 'viem';
import { adminDatabase, requireAdmin } from '@/lib/server/admin';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { applyModeration, ModerationAction } from '@/lib/server/moderation';
import { indexerUrl } from '@/lib/server/env';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store' };
export async function GET(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin('moderation');
    const sql = adminDatabase();
    const query = new URL(request.url).searchParams;
    const status = z
      .enum(['open', 'resolved', 'dismissed', 'all'])
      .parse(query.get('status') ?? 'open');
    const reason = z
      .enum(['spam', 'harassment', 'illegal', 'other', 'all'])
      .parse(query.get('reason') ?? 'all');
    const target = (query.get('target') ?? '').toLowerCase().slice(0, 80);
    const before = z
      .string()
      .regex(/^[0-9]{1,19}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n)
      .parse(query.get('before') ?? '9223372036854775807');
    const reports =
      await sql`SELECT id::text, reporter, target_type, target, reason, details, status, created_at FROM lens_web.moderation_reports
      WHERE id < ${before}::bigint ${status === 'all' ? sql`` : sql`AND status = ${status}`}
      ${reason === 'all' ? sql`` : sql`AND reason = ${reason}`} ${target ? sql`AND target = ${target}` : sql``} ORDER BY id DESC LIMIT 100`;
    const [accounts, posts, filters, log] = await Promise.all([
      sql`SELECT * FROM lens_web.moderation_accounts ORDER BY created_at DESC LIMIT 500`,
      sql`SELECT * FROM lens_web.moderation_posts LIMIT 500`,
      sql`SELECT id::text, kind, pattern, action, reason FROM lens_web.moderation_filters ORDER BY id DESC`,
      sql`SELECT id::text, actor, action, details, created_at FROM lens_web.audit_log WHERE action LIKE 'moderation.%'
        ${target ? sql`AND (details->>'target' = ${target} OR details->>'owner' = ${target})` : sql``} ORDER BY id DESC LIMIT 100`,
    ]);
    const invites =
      admin.role === 'moderator'
        ? []
        : await sql`SELECT i.id::text, i.max_uses, i.uses, i.expires_at, i.created_by,
      coalesce((SELECT jsonb_agg(jsonb_build_object('owner', r.owner, 'at', r.redeemed_at)) FROM lens_web.moderation_redemptions r WHERE r.invite_id = i.id), '[]'::jsonb) AS redeemed
      FROM lens_web.moderation_invites i ORDER BY i.id DESC LIMIT 200`;
    const allowlist =
      admin.role === 'moderator'
        ? []
        : await sql`SELECT address, added_by FROM lens_web.moderation_allowlist ORDER BY created_at DESC LIMIT 5000`;
    return Response.json(
      {
        reports,
        accounts,
        posts,
        filters,
        invites,
        allowlist,
        log,
        next: reports.length === 100 ? reports[99]!.id : null,
      },
      { headers: NO_STORE }
    );
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin('moderation');
    assertSameOrigin(request);
    const body = await request.json();
    // CSV accepts addresses or Lens usernames in its first column, with an optional header.
    // Resolve the full import before writing anything, so one invalid row cannot partially apply it.
    if (body.action === 'allowlistImport') {
      if (admin.role === 'moderator') throw new HttpError(404, 'Not found');
      const { csv, remove } = z
        .object({ csv: z.string().max(500_000), remove: z.boolean().default(false) })
        .parse(body);
      const identities = csv
        .split(/\r?\n/)
        .map((row) => row.split(',')[0]!.trim().replace(/^"|"$/g, ''))
        .filter((v) => v && !['address', 'username', 'account'].includes(v.toLowerCase()));
      if (!identities.length || identities.length > 5000)
        throw new HttpError(400, 'Import 1–5000 addresses or usernames');
      const addresses: string[] = [];
      for (const identity of identities) {
        if (isAddress(identity)) {
          addresses.push(identity);
          continue;
        }
        if (!/^@?[a-z0-9_-]{1,30}$/.test(identity))
          throw new HttpError(400, `Invalid identity: ${identity.slice(0, 40)}`);
        const response = await fetch(
          `${indexerUrl()}/accounts/${encodeURIComponent(identity.replace(/^@/, ''))}`,
          { cache: 'no-store', signal: AbortSignal.timeout(5000) }
        );
        const account = response.ok ? (await response.json()).account : null;
        if (!account || !isAddress(account.address) || !isAddress(account.owner))
          throw new HttpError(400, `Username not found: ${identity}`);
        // Existing account admission follows its address; sign-up admission follows its current owner.
        addresses.push(account.address, account.owner);
      }
      return Response.json(
        await applyModeration(
          ModerationAction.parse({
            action: 'allowlist',
            addresses: [...new Set(addresses.map((a) => a.toLowerCase()))],
            remove,
          }),
          admin.address,
          admin.role
        ),
        { headers: NO_STORE }
      );
    }
    return Response.json(
      await applyModeration(ModerationAction.parse(body), admin.address, admin.role),
      { headers: NO_STORE }
    );
  });
}
