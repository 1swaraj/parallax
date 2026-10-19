import { createHmac, randomBytes } from 'node:crypto';
import type { NotificationView, Page } from '@lens-monad/protocol';
import type { Address } from 'viem';
import { database, migrate } from './db';
import { sendEmail } from './email';
import { getInstanceConfig } from './instance-config';
import { getSecret } from './secrets';
import { checkHealth, type Health } from './health';
import { tokenHash } from './setup';
import { accountsOwnedBy } from './accounts';
import { serverState } from './state';
import { HttpError } from './guard';

export type AdminNotificationType =
  'relayer_low_balance' | 'health_degraded' | 'gas_budget_exhausted' | 'new_reports';
export async function emailAvailable() {
  const config = await getInstanceConfig();
  return (
    !!process.env.DATABASE_URL &&
    !!process.env.INSTANCE_SECRET &&
    config.userEmailEnabled &&
    !!config.emailFrom &&
    !!config.appUrl &&
    !!(await getSecret('resendApiKey'))
  );
}
function unsubscribeToken(owner: string, verificationHash: string) {
  const key = process.env.INSTANCE_SECRET;
  if (!key || key.length < 32)
    throw new Error('INSTANCE_SECRET is required for email subscriptions');
  return createHmac('sha256', key)
    .update(`parallax:email:unsubscribe:${owner}:${verificationHash}`)
    .digest('hex');
}
export async function subscribeEmail(owner: string, email: string, frequency: 'daily' | 'weekly') {
  if (!(await emailAvailable())) throw new HttpError(404, 'Not found');
  const sql = database();
  if (!sql) throw new HttpError(503, 'Email requires Postgres');
  const config = await getInstanceConfig();
  const token = randomBytes(32).toString('hex');
  const hash = tokenHash(token);
  const unsubscribe = unsubscribeToken(owner, hash);
  await sql`INSERT INTO lens_web.email_subscriptions (owner, email, frequency, token_hash, unsubscribe_hash, verify_expires_at)
    VALUES (${owner}, ${email}, ${frequency}, ${hash}, ${tokenHash(unsubscribe)}, now() + interval '24 hours')
    ON CONFLICT (owner) DO UPDATE SET email = excluded.email, frequency = excluded.frequency, verified = false,
    token_hash = excluded.token_hash, unsubscribe_hash = excluded.unsubscribe_hash, verify_expires_at = excluded.verify_expires_at, updated_at = now(), sent_at = now()`;
  await sendEmail({
    to: email,
    subject: 'Confirm your email',
    text: `Confirm your email to receive a ${frequency} notification digest. This link expires in 24 hours.\n\n${config.appUrl.replace(/\/+$/, '')}/api/email/verify?token=${token}`,
    unsubscribe: `${config.appUrl.replace(/\/+$/, '')}/api/email/unsubscribe?token=${unsubscribe}`,
  });
}
export async function verifyEmail(token: string) {
  const sql = database();
  if (!sql || !/^[a-f0-9]{64}$/.test(token)) return false;
  await migrate(sql);
  const rows =
    await sql`UPDATE lens_web.email_subscriptions SET verified = true WHERE token_hash = ${tokenHash(token)} AND verify_expires_at > now() AND verified = false RETURNING owner`;
  return rows.length > 0;
}
export async function unsubscribeEmail(token: string) {
  const sql = database();
  if (!sql || !/^[a-f0-9]{64}$/.test(token)) return;
  await migrate(sql);
  await sql`DELETE FROM lens_web.email_subscriptions WHERE unsubscribe_hash = ${tokenHash(token)}`;
}
/** Hook for moderation: persisted debounce is shared by all app instances. Payloads should contain counts/links, never report text or secrets. */
export async function notifyAdmins(
  type: AdminNotificationType,
  payload: Record<string, string | number>
) {
  const sql = database();
  if (!sql) return;
  await migrate(sql);
  const config = await getInstanceConfig();
  if (!config.emailFrom || !(await getSecret('resendApiKey'))) return;
  const recipients = await sql.begin(async (tx): Promise<{ email: string }[]> => {
    await tx`INSERT INTO lens_web.alert_state (type) VALUES (${type}) ON CONFLICT DO NOTHING`;
    const [state] =
      await tx`SELECT sent_at FROM lens_web.alert_state WHERE type = ${type} FOR UPDATE`;
    if (state?.sent_at && Date.now() - state.sent_at.getTime() < 3_600_000) return [];
    const admins = await tx<
      { email: string }[]
    >`SELECT email FROM lens_web.instance_admins WHERE alerts = true AND email IS NOT NULL`;
    if (!admins.length) return [];
    // Reserve before contacting the provider: partial failure must not resend to successful recipients.
    await tx`UPDATE lens_web.alert_state SET sent_at = now() WHERE type = ${type}`;
    return admins;
  });
  for (const admin of recipients) {
    try {
      await sendEmail({
        to: admin.email,
        subject: type.replaceAll('_', ' '),
        text: Object.entries(payload)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n'),
        idempotencyKey: `alert-${type}-${tokenHash(admin.email).slice(0, 16)}-${Math.floor(Date.now() / 3_600_000)}`,
      });
    } catch {
      console.error(`Could not send operator alert (${type}); the next attempt is in one hour`);
    }
  }
}
export function healthAlerts(health: Health) {
  return {
    relayer_low_balance: health.relayers.some((r) => r.low),
    gas_budget_exhausted:
      health.gas.budgetPerHour !== null &&
      health.gas.usedThisHour !== null &&
      BigInt(health.gas.usedThisHour) >= BigInt(health.gas.budgetPerHour),
    health_degraded: !health.healthy,
  };
}
export async function runOperatorAlerts() {
  const sql = database();
  if (!sql) return;
  const health = await checkHealth();
  for (const [type, active] of Object.entries(healthAlerts(health))) {
    if (type === 'health_degraded') {
      if (!active) {
        await sql`UPDATE lens_web.alert_state SET first_seen = NULL WHERE type = ${type}`;
        continue;
      }
      const [state] =
        await sql`INSERT INTO lens_web.alert_state (type) VALUES (${type}) ON CONFLICT (type) DO UPDATE SET first_seen = coalesce(lens_web.alert_state.first_seen, now()) RETURNING first_seen`;
      if (Date.now() - state!.first_seen.getTime() < 300_000) continue;
    }
    if (active)
      await notifyAdmins(type as AdminNotificationType, {
        message:
          type === 'health_degraded'
            ? 'Instance health has been degraded for at least five minutes.'
            : type === 'relayer_low_balance'
              ? 'A relayer balance is below the configured minimum.'
              : 'The hourly gas budget is exhausted.',
        admin: `${(await getInstanceConfig()).appUrl}/admin`,
      });
  }
}
export async function runDigests() {
  if (!(await emailAvailable())) return { processed: 0 };
  const sql = database()!;
  const config = await getInstanceConfig();
  let processed = 0;
  const deadline = Date.now() + 40_000;
  const candidates =
    await sql`SELECT owner FROM lens_web.email_subscriptions WHERE verified = true AND
    sent_at <= now() - CASE frequency WHEN 'daily' THEN interval '1 day' ELSE interval '7 days' END
    ORDER BY sent_at LIMIT 50`;
  // Commit each recipient separately; a provider failure must not roll back other deliveries.
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    try {
      await sql.begin(async (tx) => {
        const [row] =
          await tx`SELECT * FROM lens_web.email_subscriptions WHERE owner = ${candidate.owner}
          AND verified = true AND sent_at <= now() - CASE frequency WHEN 'daily' THEN interval '1 day' ELSE interval '7 days' END
          FOR UPDATE SKIP LOCKED`;
        if (!row) return;
        const accounts = await accountsOwnedBy(row.owner as Address);
        const lines: string[] = [];
        for (const account of accounts) {
          if (Date.now() >= deadline) throw new Error('Digest time limit reached');
          const response = await fetch(
            `${config.indexerUrl.replace(/\/+$/, '')}/notifications?account=${account}&limit=100`,
            {
              cache: 'no-store',
              signal: AbortSignal.timeout(Math.min(5000, deadline - Date.now())),
            }
          );
          if (!response.ok) throw new Error('Could not read notifications');
          const page = (await response.json()) as Page<NotificationView>;
          const since = row.sent_at.getTime();
          for (const item of page.items.filter((n) => Number(n.createdAt) * 1000 > since)) {
            lines.push(
              `${item.actor.username || item.actor.address}: ${item.type}${item.post ? ` — ${config.appUrl}/p/${item.post.id}` : ''}`
            );
          }
          const likes = await serverState().likes.received(account, {
            since: row.sent_at,
            limit: 100,
          });
          for (const item of likes.items.filter((like) => new Date(like.likedAt).getTime() > since))
            lines.push(`A new like on ${config.appUrl}/p/${item.postId}`);
        }
        if (lines.length) {
          const token = unsubscribeToken(row.owner, row.token_hash);
          await sendEmail({
            to: row.email,
            subject: 'Your notification digest',
            text: `${lines.slice(0, 100).join('\n')}\n\nView all notifications: ${config.appUrl}/notifications`,
            unsubscribe: `${config.appUrl.replace(/\/+$/, '')}/api/email/unsubscribe?token=${token}`,
            idempotencyKey: `digest-${row.owner}-${new Date(row.sent_at).getTime()}`,
          });
        }
        await tx`UPDATE lens_web.email_subscriptions SET sent_at = now() WHERE owner = ${row.owner}`;
        processed++;
      });
    } catch {
      console.error('Could not process an email digest; it will be retried on the next cron run');
    }
  }
  return { processed };
}
