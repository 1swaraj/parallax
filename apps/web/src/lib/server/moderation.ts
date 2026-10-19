import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { erc20Abi, erc721Abi, erc1155Abi, isAddress, type Address } from 'viem';
import {
  accessDecision,
  accountRate,
  allowedIdentity,
  emptyModeration,
  FilterInput,
  sponsorshipDecision,
  type ModerationSnapshot,
  type ModeratedAccount,
  type ModerationPolicy,
} from '../moderation-policy';
import { database, migrate, type WriteSql } from './db';
import { currentConfig } from './instance-config';
import { HttpError } from './guard';
import { publicClient } from './chain';
import { getSecret } from './secrets';
import { rateLimit } from './state';
import { indexerUrl } from './env';
import type { AdminRole } from './admin';

export const MODERATION_CACHE_MS = 5000;
let cached: { state: ModerationSnapshot; until: number } | undefined;
let pending: Promise<ModerationSnapshot> | undefined;
let generation = 0;
export function invalidateModeration() {
  cached = undefined;
  generation++;
}
export async function moderationSnapshot(): Promise<ModerationSnapshot> {
  if (cached && cached.until > Date.now()) return cached.state;
  const sql = database();
  if (!sql) return emptyModeration();
  pending ??= (async () => {
    const version = generation;
    await migrate(sql);
    const [accounts, posts, filters, allowlist, signups] = await Promise.all([
      sql`SELECT * FROM lens_web.moderation_accounts`,
      sql`SELECT * FROM lens_web.moderation_posts`,
      sql`SELECT id::text, kind, pattern, action, reason FROM lens_web.moderation_filters ORDER BY id`,
      sql`SELECT address FROM lens_web.moderation_allowlist`,
      sql`SELECT account, created_at FROM lens_web.signups`,
    ]);
    const state = emptyModeration();
    for (const row of signups)
      state.accounts.set(row.account, {
        account: row.account,
        owner: null,
        member: true,
        approved: false,
        hidden: false,
        suspended: false,
        sponsorRevoked: false,
        label: null,
        reason: '',
        createdAt: row.created_at.getTime(),
      });
    for (const row of accounts)
      state.accounts.set(row.account, {
        account: row.account,
        owner: row.owner,
        member: row.member || state.accounts.get(row.account)?.member || false,
        approved: row.approved,
        hidden: row.hidden,
        suspended: row.suspended,
        sponsorRevoked: row.sponsor_revoked,
        label: row.label,
        reason: row.reason,
        createdAt: state.accounts.get(row.account)?.createdAt ?? row.created_at.getTime(),
      });
    for (const row of posts)
      state.posts.set(row.post_id, { action: row.action, reason: row.reason });
    state.filters = filters as unknown as ModerationSnapshot['filters'];
    for (const row of allowlist) state.allowlist.add(row.address);
    if (version === generation) cached = { state, until: Date.now() + MODERATION_CACHE_MS };
    return state;
  })().finally(() => {
    pending = undefined;
  });
  const state = await pending;
  return cached ? state : moderationSnapshot();
}

const tokenCache = new Map<string, { value: Promise<boolean>; until: number }>();
export const TOKEN_CACHE_MS = 30_000;
export function clearTokenCache() {
  tokenCache.clear();
}
export async function holdsToken(
  owner: Address,
  token: ModerationPolicy['token']
): Promise<boolean> {
  if (!isAddress(token.address)) throw new HttpError(503, 'The token gate is not configured');
  const key = `${owner.toLowerCase()}:${JSON.stringify(token)}`;
  const existing = tokenCache.get(key);
  if (existing && existing.until > Date.now()) return existing.value;
  if (tokenCache.size > 10000) tokenCache.clear();
  const address = token.address as Address;
  const value = (async () => {
    const balance =
      token.standard === 'erc1155'
        ? await publicClient.readContract({
            address,
            abi: erc1155Abi,
            functionName: 'balanceOf',
            args: [owner, BigInt(token.tokenId)],
          })
        : token.standard === 'erc721'
          ? await publicClient.readContract({
              address,
              abi: erc721Abi,
              functionName: 'balanceOf',
              args: [owner],
            })
          : await publicClient.readContract({
              address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [owner],
            });
    return balance >= (token.standard === 'erc20' ? BigInt(token.minimum) : 1n);
  })().catch(() => {
    tokenCache.delete(key);
    throw new HttpError(503, 'Could not check the token gate. Try again.');
  });
  tokenCache.set(key, { value, until: Date.now() + TOKEN_CACHE_MS });
  return value;
}

export async function assertAccess(owner: Address, account?: Address) {
  const policy = currentConfig().moderation;
  const state = await moderationSnapshot();
  const denied = accessDecision(policy, state, owner, account);
  if (denied) throw new HttpError(403, denied);
  if (account && policy.signupMode === 'token' && !(await holdsToken(owner, policy.token)))
    throw new HttpError(403, 'Your wallet no longer meets this instance’s token gate');
}

/** Record indexed creation time at session boundaries, outside the relay's hot path. */
export async function rememberExternalAccount(account: Address, owner: Address) {
  if ((await moderationSnapshot()).accounts.has(account.toLowerCase())) return;
  const sql = database();
  if (!sql) return;
  const response = await fetch(`${indexerUrl()}/accounts/${account}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new HttpError(503, 'Could not read this account');
  const { account: indexed } = await response.json();
  const time = Number(indexed.createdAt) * 1000;
  const createdAt =
    Number.isFinite(time) && time > 0 && time <= Date.now() + 60_000 ? new Date(time) : new Date();
  await sql`INSERT INTO lens_web.moderation_accounts (account, owner, created_at) VALUES (${account.toLowerCase()}, ${owner.toLowerCase()}, ${createdAt}) ON CONFLICT DO NOTHING`;
  invalidateModeration();
}

export async function assertSponsorPolicy(owner: Address, account: Address) {
  await assertAccess(owner, account);
  const policy = currentConfig().moderation;
  const status = (await moderationSnapshot()).accounts.get(account.toLowerCase());
  const denied = sponsorshipDecision(policy, status);
  if (denied) throw new HttpError(403, denied);
  await rateLimit(`moderation-relay:${account}`, accountRate(policy, status), 60_000);
}

export async function verifyTurnstile(
  token: unknown,
  request: Request,
  send: typeof fetch = fetch
) {
  const policy = currentConfig().moderation;
  if (!policy.turnstileEnabled) return;
  const secret = await getSecret('captchaSecret');
  if (!secret || !policy.turnstileSiteKey)
    throw new HttpError(503, 'Sign-up bot check is not configured');
  if (typeof token !== 'string' || !token || token.length > 2048)
    throw new HttpError(403, 'Complete the bot check');
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await send('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new HttpError(503, 'Bot check unavailable. Try again.');
  }
  const hostname = new URL(currentConfig().appUrl || request.url).hostname;
  if (!result.success || result.hostname !== hostname || result.action !== 'signup')
    throw new HttpError(403, 'Bot check failed. Try again.');
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function auditModeration(
  sql: WriteSql,
  actor: string,
  action: string,
  details: Record<string, unknown>
) {
  await sql`INSERT INTO lens_web.audit_log (actor, action, details) VALUES (${actor}, ${`moderation.${action}`}, ${sql.json(JSON.parse(JSON.stringify(details)))})`;
}
export async function redeemInvite(sql: WriteSql, code: string, owner: string) {
  const [invite] =
    await sql`SELECT * FROM lens_web.moderation_invites WHERE code_hash = ${hash(code)} FOR UPDATE`;
  if (!invite || invite.expires_at <= new Date())
    throw new HttpError(403, 'Invalid or expired invite code');
  const [redeemed] =
    await sql`SELECT account FROM lens_web.moderation_redemptions WHERE invite_id = ${invite.id} AND owner = ${owner.toLowerCase()}`;
  if (redeemed?.account) throw new HttpError(403, 'This wallet already used this invite to join');
  if (redeemed) return;
  if (invite.uses >= invite.max_uses) throw new HttpError(403, 'This invite code is used up');
  await sql`UPDATE lens_web.moderation_invites SET uses = uses + 1 WHERE id = ${invite.id}`;
  await sql`INSERT INTO lens_web.moderation_redemptions (invite_id, owner) VALUES (${invite.id}, ${owner.toLowerCase()})`;
  await auditModeration(sql, owner, 'invite.redeem', {
    inviteId: String(invite.id),
    owner: owner.toLowerCase(),
  });
}

/** A short-lived admission also covers wallet-paid creation; the client cannot assert membership. */
export async function authorizeSignup(
  owner: Address,
  body: Record<string, unknown>,
  request: Request
) {
  const policy = currentConfig().moderation;
  const snapshot = await moderationSnapshot();
  if (snapshot.accounts.get(owner.toLowerCase())?.suspended)
    throw new HttpError(403, 'This wallet is suspended on this instance');
  await verifyTurnstile(body.turnstileToken, request);
  if (policy.signupMode === 'allowlist' && !allowedIdentity(snapshot, owner))
    throw new HttpError(403, 'Your wallet is not on this instance’s allowlist');
  if (policy.signupMode === 'token' && !(await holdsToken(owner, policy.token)))
    throw new HttpError(403, 'Your wallet does not meet this instance’s token gate');
  const sql = database();
  if (!sql) {
    if (policy.signupMode !== 'open') throw new HttpError(503, 'Access controls require Postgres');
    return;
  }
  await migrate(sql);
  await sql.begin(async (tx) => {
    if (policy.signupMode === 'invite') {
      if (typeof body.inviteCode !== 'string' || body.inviteCode.length > 200)
        throw new HttpError(403, 'An invite code is required');
      await redeemInvite(tx, body.inviteCode.trim(), owner);
    }
    await tx`INSERT INTO lens_web.moderation_admissions (owner, expires_at) VALUES (${owner.toLowerCase()}, now() + interval '15 minutes')
      ON CONFLICT (owner) DO UPDATE SET issued_at = now(), expires_at = excluded.expires_at`;
  });
}
export async function registerMember(account: Address, owner: Address, createdAt = new Date()) {
  const sql = database();
  if (!sql) return;
  await migrate(sql);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO lens_web.signups (account, created_at) VALUES (${account.toLowerCase()}, ${createdAt}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO lens_web.moderation_accounts (account, owner, member, created_at) VALUES (${account.toLowerCase()}, ${owner.toLowerCase()}, true, ${createdAt})
      ON CONFLICT (account) DO UPDATE SET owner = excluded.owner, member = true`;
    await tx`DELETE FROM lens_web.moderation_admissions WHERE owner = ${owner.toLowerCase()}`;
    await tx`UPDATE lens_web.moderation_redemptions SET account = ${account.toLowerCase()} WHERE owner = ${owner.toLowerCase()} AND account IS NULL`;
  });
  invalidateModeration();
}
export async function selectDirectSignup(account: Address, owner: Address) {
  const sql = database();
  if (!sql) return;
  await migrate(sql);
  const [permit] =
    await sql`SELECT * FROM lens_web.moderation_admissions WHERE owner = ${owner.toLowerCase()} AND expires_at > now()`;
  if (!permit) throw new HttpError(403, 'Complete this instance’s sign-up checks first');
  const response = await fetch(`${indexerUrl()}/accounts/${account}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new HttpError(503, 'Wait for the new account to be indexed');
  const { account: indexed } = await response.json();
  const createdAt = new Date(Number(indexed.createdAt) * 1000);
  if (
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.getTime() < permit.issued_at.getTime() - 2000 ||
    createdAt.getTime() > Date.now() + 60_000
  )
    throw new HttpError(403, 'This admission only covers a newly created account');
  await registerMember(account, owner, createdAt);
}

export const ModerationAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('account'),
    target: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .transform((v) => v.toLowerCase()),
    operation: z.enum([
      'hide',
      'unhide',
      'suspend',
      'unsuspend',
      'approve',
      'unapprove',
      'revoke',
      'restore',
      'label',
      'unlabel',
    ]),
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal('post'),
    target: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
    operation: z.enum(['hide', 'label', 'restore']),
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({ action: z.literal('filter'), filter: FilterInput }),
  z.object({ action: z.literal('deleteFilter'), id: z.string().regex(/^[0-9]{1,18}$/) }),
  z.object({
    action: z.literal('allowlist'),
    addresses: z
      .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
      .min(1)
      .max(5000),
    remove: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('invites'),
    count: z.number().int().min(1).max(200),
    maxUses: z.number().int().min(1).max(10000),
    expiresAt: z
      .string()
      .datetime()
      .refine((v) => new Date(v) > new Date(), 'Expiry must be in the future'),
  }),
  z.object({ action: z.literal('revokeInvite'), id: z.string().regex(/^[0-9]{1,18}$/) }),
  z.object({
    action: z.literal('reports'),
    ids: z
      .array(z.string().regex(/^[0-9]{1,18}$/))
      .min(1)
      .max(100),
    operation: z.enum(['hide', 'suspend', 'dismiss']),
    reason: z.string().trim().min(1).max(500),
  }),
]);
export async function applyModeration(
  input: z.infer<typeof ModerationAction>,
  actor: string,
  role: AdminRole
) {
  const sql = database();
  if (!sql) throw new HttpError(503, 'Moderation requires Postgres');
  const adminOnly = ['allowlist', 'invites', 'revokeInvite'];
  if (
    role === 'moderator' &&
    (adminOnly.includes(input.action) ||
      (input.action === 'account' &&
        ['approve', 'unapprove', 'revoke', 'restore'].includes(input.operation)) ||
      (input.action === 'filter' && input.filter.kind === 'regex'))
  )
    throw new HttpError(404, 'Not found');
  await migrate(sql);
  const codes: string[] = [];
  await sql.begin(async (tx) => {
    if (input.action === 'account')
      await setAccount(tx, input.target, input.operation, input.reason);
    if (input.action === 'post') await setPost(tx, input.target, input.operation, input.reason);
    if (input.action === 'filter') {
      const [count] = await tx`SELECT count(*)::int AS n FROM lens_web.moderation_filters`;
      if (count!.n >= 200) throw new HttpError(400, 'At most 200 filters');
      await tx`INSERT INTO lens_web.moderation_filters (kind, pattern, action, reason, created_by) VALUES (${input.filter.kind}, ${input.filter.pattern}, ${input.filter.action}, ${input.filter.reason}, ${actor})`;
    }
    if (input.action === 'deleteFilter') {
      const [filter] =
        await tx`SELECT kind FROM lens_web.moderation_filters WHERE id = ${input.id}::bigint`;
      if (role === 'moderator' && filter?.kind === 'regex') throw new HttpError(404, 'Not found');
      await tx`DELETE FROM lens_web.moderation_filters WHERE id = ${input.id}::bigint`;
    }
    if (input.action === 'allowlist')
      for (const address of input.addresses) {
        if (input.remove)
          await tx`DELETE FROM lens_web.moderation_allowlist WHERE address = ${address.toLowerCase()}`;
        else
          await tx`INSERT INTO lens_web.moderation_allowlist (address, added_by) VALUES (${address.toLowerCase()}, ${actor}) ON CONFLICT DO NOTHING`;
      }
    if (input.action === 'invites')
      for (let i = 0; i < input.count; i++) {
        const code = randomBytes(18).toString('base64url');
        codes.push(code);
        await tx`INSERT INTO lens_web.moderation_invites (code_hash, max_uses, expires_at, created_by) VALUES (${hash(code)}, ${input.maxUses}, ${new Date(input.expiresAt)}, ${actor})`;
      }
    if (input.action === 'revokeInvite')
      await tx`UPDATE lens_web.moderation_invites SET expires_at = now() WHERE id = ${input.id}::bigint`;
    if (input.action === 'reports') {
      const reports =
        await tx`SELECT * FROM lens_web.moderation_reports WHERE id::text IN ${tx(input.ids)} AND status = 'open' FOR UPDATE`;
      for (const report of reports) {
        if (input.operation === 'hide') {
          if (report.target_type === 'post') await setPost(tx, report.target, 'hide', input.reason);
          else await setAccount(tx, report.target, 'hide', input.reason);
        }
        if (input.operation === 'suspend') {
          let account = report.target;
          if (report.target_type === 'post') {
            const response = await fetch(`${indexerUrl()}/posts/${report.target}`, {
              cache: 'no-store',
              signal: AbortSignal.timeout(5000),
            });
            if (!response.ok)
              throw new HttpError(400, 'Could not resolve the reported post’s author');
            account = (await response.json()).post?.author?.address;
          }
          if (!isAddress(account)) throw new HttpError(400, 'Invalid report target');
          await setAccount(tx, account, 'suspend', input.reason);
          await auditModeration(tx, actor, 'account', {
            target: account.toLowerCase(),
            operation: 'suspend',
            reason: input.reason,
            reportId: String(report.id),
          });
        }
        await tx`UPDATE lens_web.moderation_reports SET status = ${input.operation === 'dismiss' ? 'dismissed' : 'resolved'}, resolved_at = now() WHERE id = ${report.id}`;
        await auditModeration(tx, actor, `report.${input.operation}`, {
          reportId: String(report.id),
          target: report.target,
          targetType: report.target_type,
          reason: input.reason,
        });
      }
    }
    // Codes are returned once; only their IDs/count are audited.
    await auditModeration(
      tx,
      actor,
      input.action,
      input.action === 'invites'
        ? { count: input.count, maxUses: input.maxUses, expiresAt: input.expiresAt }
        : input
    );
  });
  invalidateModeration();
  return { saved: true, codes };
}
async function setPost(sql: WriteSql, target: string, operation: string, reason: string) {
  if (operation === 'restore')
    await sql`DELETE FROM lens_web.moderation_posts WHERE post_id = ${target}`;
  else
    await sql`INSERT INTO lens_web.moderation_posts (post_id, action, reason) VALUES (${target}, ${operation}, ${reason})
    ON CONFLICT (post_id) DO UPDATE SET action = excluded.action, reason = excluded.reason`;
}
async function setAccount(sql: WriteSql, target: string, operation: string, reason: string) {
  await sql`INSERT INTO lens_web.moderation_accounts (account) VALUES (${target.toLowerCase()}) ON CONFLICT DO NOTHING`;
  const column = {
    hide: 'hidden',
    unhide: 'hidden',
    suspend: 'suspended',
    unsuspend: 'suspended',
    approve: 'approved',
    unapprove: 'approved',
    revoke: 'sponsor_revoked',
    restore: 'sponsor_revoked',
    label: 'label',
    unlabel: 'label',
  }[operation]!;
  const value =
    operation === 'label'
      ? reason
      : operation === 'unlabel'
        ? null
        : ['hide', 'suspend', 'approve', 'revoke'].includes(operation);
  await sql`UPDATE lens_web.moderation_accounts SET ${sql(column)} = ${value}, reason = ${reason} WHERE account = ${target.toLowerCase()}`;
}
