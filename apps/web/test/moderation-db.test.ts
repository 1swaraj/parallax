import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPost, textOnlyPost, toDataURI } from '@lens-monad/protocol';
import { TEST_DATABASE_URL, testDatabase } from './helpers';
import { account, owner, other, postView } from './moderation-fixtures';
import type { Sql } from '../src/lib/server/db';

let sql: Sql;
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  session: vi.fn(),
  notify: vi.fn(),
  send: vi.fn(),
  owned: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/lib/server/db', async (original) => ({
  ...(await original<typeof import('../src/lib/server/db')>()),
  database: () => sql ?? null,
}));
vi.mock('../src/lib/server/chain', () => ({
  publicClient: { readContract: mocks.read },
  isOwnedBy: mocks.owned,
  isSponsored: async () => true,
  sendAsRelayer: mocks.send,
}));
vi.mock('../src/lib/server/session', () => ({ getSession: mocks.session }));
vi.mock('../src/lib/server/notifications-email', () => ({ notifyAdmins: mocks.notify }));
import { connect, migrate } from '../src/lib/server/db';
import {
  getInstanceConfig,
  invalidateInstanceConfig,
  writeConfig,
} from '../src/lib/server/instance-config';
import {
  applyModeration,
  assertAccess,
  authorizeSignup,
  clearTokenCache,
  holdsToken,
  invalidateModeration,
  ModerationAction,
  moderationSnapshot,
  redeemInvite,
  registerMember,
  selectDirectSignup,
  verifyTurnstile,
  assertSponsorPolicy,
} from '../src/lib/server/moderation';
import { ModerationPolicy } from '../src/lib/moderation-policy';
import { assertRelayContent } from '../src/lib/server/sponsor';
import { contracts } from '../src/lib/config';
import { POST as report } from '../src/app/api/reports/route';
import { POST as adminAction, GET as queue } from '../src/app/api/admin/moderation/route';
import { PUT as setConfig } from '../src/app/api/admin/config/route';
import { POST as relay } from '../src/app/api/relay/route';

const request = (path: string, body: unknown) =>
  new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
let control: Sql, dbName: string, dbUrl: string;
async function policy(value: unknown) {
  await sql.begin((tx) => writeConfig(tx, { moderation: ModerationPolicy.parse(value) }, owner));
  invalidateInstanceConfig();
  await getInstanceConfig();
}
async function action(body: unknown, role: 'owner' | 'admin' | 'moderator' = 'owner') {
  return applyModeration(ModerationAction.parse(body), owner, role);
}

describe.skipIf(!TEST_DATABASE_URL)('moderation with real Postgres and route handlers', () => {
  beforeAll(async () => {
    // A private disposable database keeps these config mutations isolated from A's concurrent tests.
    control = testDatabase();
    dbName = `moderation_${Date.now()}_${process.pid}`;
    await control.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    sql = connect(dbUrl, 10);
    await migrate(sql);
  });
  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE lens_web.instance_config, lens_web.instance_admins, lens_web.audit_log, lens_web.signups,
      lens_web.moderation_accounts, lens_web.moderation_posts, lens_web.moderation_filters, lens_web.moderation_allowlist,
      lens_web.moderation_invites, lens_web.moderation_redemptions, lens_web.moderation_admissions, lens_web.moderation_reports, lens_web.rate_limit_hits CASCADE`);
    invalidateInstanceConfig();
    invalidateModeration();
    clearTokenCache();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('DATABASE_URL', dbUrl);
    mocks.session.mockResolvedValue({ owner, account, save: async () => {} });
    mocks.owned.mockResolvedValue(true);
    mocks.read.mockResolvedValue(1n);
    mocks.notify.mockResolvedValue(undefined);
    await sql`INSERT INTO lens_web.instance_admins (address, role) VALUES (${owner}, 'owner')`;
    await getInstanceConfig();
  });
  afterAll(async () => {
    if (sql) await sql.end();
    if (control) {
      await control.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await control.end();
    }
  });

  it('allows open admission, refuses missing allowlist, and grants only allowlisted wallets', async () => {
    await authorizeSignup(owner, {}, request('/api/signup', {}));
    await policy({ signupMode: 'allowlist' });
    await expect(authorizeSignup(owner, {}, request('/api/signup', {}))).rejects.toMatchObject({
      status: 403,
    });
    await action({ action: 'allowlist', addresses: [owner] });
    await authorizeSignup(owner, {}, request('/api/signup', {}));
    expect((await sql`SELECT * FROM lens_web.moderation_admissions`).length).toBe(1);
  });
  it('generates hashed bulk invites, serializes single use, records creator/redeemer and permits retries', async () => {
    await policy({ signupMode: 'invite' });
    await expect(authorizeSignup(owner, {}, request('/api/signup', {}))).rejects.toMatchObject({
      status: 403,
    });
    const { codes } = await action({
      action: 'invites',
      count: 2,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const results = await Promise.allSettled(
      [owner, other].map((wallet) => sql.begin((tx) => redeemInvite(tx, codes[0]!, wallet)))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [redemption] = await sql`SELECT * FROM lens_web.moderation_redemptions`;
    await sql.begin((tx) => redeemInvite(tx, codes[0]!, redemption!.owner));
    const [invite] =
      await sql`SELECT * FROM lens_web.moderation_invites WHERE id = ${redemption!.invite_id}`;
    expect(invite).toMatchObject({ uses: 1, created_by: owner });
    expect(
      JSON.stringify(await sql`SELECT actor, action, details FROM lens_web.audit_log`)
    ).not.toContain(codes[0]);
    expect(
      JSON.stringify(await sql`SELECT code_hash, created_by FROM lens_web.moderation_invites`)
    ).not.toContain(codes[0]);
    await sql`UPDATE lens_web.moderation_invites SET expires_at = now() - interval '1 second'`;
    await expect(sql.begin((tx) => redeemInvite(tx, codes[1]!, owner))).rejects.toMatchObject({
      status: 403,
    });
  });
  it('supports multi-use codes and revocation', async () => {
    const { codes } = await action({
      action: 'invites',
      count: 1,
      maxUses: 2,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await Promise.all(
      [owner, other].map((wallet) => sql.begin((tx) => redeemInvite(tx, codes[0]!, wallet)))
    );
    const [invite] = await sql`SELECT id::text, uses FROM lens_web.moderation_invites`;
    expect(invite!.uses).toBe(2);
    await action({ action: 'revokeInvite', id: invite!.id });
    await expect(sql.begin((tx) => redeemInvite(tx, codes[0]!, account))).rejects.toMatchObject({
      status: 403,
    });
  });
  it.each(['erc20', 'erc721', 'erc1155'] as const)(
    'checks %s balances, caches and rechecks after cache expiration',
    async (standard) => {
      const token = { standard, address: other, minimum: '5', tokenId: '12' };
      mocks.read.mockResolvedValue(0n);
      expect(await holdsToken(owner, token)).toBe(false);
      mocks.read.mockResolvedValue(9n);
      expect(await holdsToken(owner, token)).toBe(false);
      expect(mocks.read).toHaveBeenCalledTimes(1);
      clearTokenCache();
      expect(await holdsToken(owner, token)).toBe(true);
      expect(mocks.read.mock.calls.at(-1)![0].args).toEqual(
        standard === 'erc1155' ? [owner, 12n] : [owner]
      );
      await policy({ signupMode: 'token', token });
      await authorizeSignup(owner, {}, request('/api/signup', {}));
      await assertAccess(owner, account);
      clearTokenCache();
      mocks.read.mockResolvedValue(0n);
      await expect(assertAccess(owner, account)).rejects.toMatchObject({ status: 403 });
    }
  );
  it('fails token gates closed on RPC failure or missing contract', async () => {
    const token = { address: '', standard: 'erc20' as const, minimum: '1', tokenId: '0' };
    await expect(holdsToken(owner, token)).rejects.toMatchObject({ status: 503 });
    mocks.read.mockRejectedValue(new Error('RPC down'));
    await expect(holdsToken(owner, { ...token, address: other })).rejects.toMatchObject({
      status: 503,
    });
  });
  it('verifies Turnstile token, action, hostname, provider failures and disabled mode', async () => {
    await verifyTurnstile(undefined, request('/api/signup', {}));
    await policy({ turnstileEnabled: true, turnstileSiteKey: 'test-site-key' });
    await expect(verifyTurnstile('proof', request('/api/signup', {}))).rejects.toMatchObject({
      status: 503,
    });
    vi.stubEnv('CAPTCHA_SECRET', 'anvil-test-secret');
    await expect(verifyTurnstile(undefined, request('/api/signup', {}))).rejects.toMatchObject({
      status: 403,
    });
    for (const result of [
      { success: false },
      { success: true, hostname: 'wrong', action: 'signup' },
      { success: true, hostname: 'localhost', action: 'login' },
    ]) {
      await expect(
        verifyTurnstile(
          'proof',
          request('/api/signup', {}),
          vi.fn(async () => Response.json(result))
        )
      ).rejects.toMatchObject({ status: 403 });
    }
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, hostname: 'localhost', action: 'signup' })
    );
    await verifyTurnstile('proof', request('/api/signup', {}), send);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({
      secret: 'anvil-test-secret',
      response: 'proof',
    });
    await expect(
      verifyTurnstile(
        'proof',
        request('/api/signup', {}),
        vi.fn(async () => {
          throw new Error();
        })
      )
    ).rejects.toMatchObject({ status: 503 });
  });
  it('requires a server admission for wallet-paid membership and checks indexed creation time', async () => {
    await expect(selectDirectSignup(account, owner)).rejects.toMatchObject({ status: 403 });
    await authorizeSignup(owner, {}, request('/api/signup', {}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ account: { createdAt: '1' } }))
    );
    await expect(selectDirectSignup(account, owner)).rejects.toMatchObject({ status: 403 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ account: { createdAt: String(Math.floor(Date.now() / 1000)) } })
      )
    );
    await selectDirectSignup(account, owner);
    expect((await moderationSnapshot()).accounts.get(account)?.member).toBe(true);
    expect(await sql`SELECT * FROM lens_web.moderation_admissions`).toHaveLength(0);
  });
  it('checks suspension and sponsorship revoke before any simulation, including old sessions', async () => {
    await registerMember(account, owner);
    await action({ action: 'account', target: account, operation: 'suspend', reason: 'spam' });
    const response = await relay(
      request(
        '/api/relay',
        createPost(contracts.LensGlobalFeed, account, toDataURI(textOnlyPost('safe post')))
      )
    );
    expect(response.status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
    await action({ action: 'account', target: account, operation: 'unsuspend', reason: 'appeal' });
    await action({ action: 'account', target: account, operation: 'revoke', reason: 'budget' });
    await expect(assertSponsorPolicy(owner, account)).rejects.toMatchObject({ status: 403 });
    await assertAccess(owner, account); // wallet-paid access survives sponsorship revoke
  });
  it('blocks filtered relay text before ownership checks and permits hide/label rules', async () => {
    const call = createPost(contracts.LensGlobalFeed, account, toDataURI(textOnlyPost('badword')));
    await action({
      action: 'filter',
      filter: { kind: 'word', pattern: 'badword', action: 'block', reason: 'spam' },
    });
    const response = await relay(request('/api/relay', call));
    expect(response.status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.owned).not.toHaveBeenCalled();
    await sql`DELETE FROM lens_web.moderation_filters`;
    invalidateModeration();
    for (const actionName of ['hide', 'label']) {
      await action({
        action: 'filter',
        filter: { kind: 'word', pattern: 'badword', action: actionName, reason: 'warning' },
      });
      await assertRelayContent(call.target, call.data);
    }
    const remote = createPost(
      contracts.LensGlobalFeed,
      account,
      'https://uninspectable.example/post.json'
    );
    await expect(assertRelayContent(remote.target, remote.data)).rejects.toMatchObject({
      status: 400,
    });
    // An image post without a caption has no text to check.
    const image = createPost(
      contracts.LensGlobalFeed,
      account,
      toDataURI({
        lens: {
          id: 'image',
          locale: 'en',
          mainContentFocus: 'IMAGE',
          image: { item: 'https://app.example/media/1', type: 'image/png', attributes: [] },
        },
      })
    );
    await assertRelayContent(image.target, image.data);
  });
  it('reports → queue → bulk hide/dismiss, deduplicates open reports and calls notifyAdmins once', async () => {
    const body = { targetType: 'post', target: '42', reason: 'spam', details: 'review this' };
    expect((await report(request('/api/reports', body))).status).toBe(200);
    expect((await report(request('/api/reports', body))).status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith('new_reports', {
      count: 1,
      page: '/admin/moderation',
    });
    const data = await (
      await queue(new Request('http://localhost:3000/api/admin/moderation?reason=spam'))
    ).json();
    expect(data.reports, JSON.stringify(data)).toHaveLength(1);
    const response = await adminAction(
      request('/api/admin/moderation', {
        action: 'reports',
        ids: [data.reports[0].id],
        operation: 'hide',
        reason: 'confirmed spam',
      })
    );
    expect(response.status).toBe(200);
    expect((await moderationSnapshot()).posts.get('42')).toEqual({
      action: 'hide',
      reason: 'confirmed spam',
    });
    expect((await sql`SELECT status FROM lens_web.moderation_reports`)[0]!.status).toBe('resolved');
    expect(
      await sql`SELECT * FROM lens_web.audit_log WHERE action = 'moderation.report.hide'`
    ).toHaveLength(1);
  });
  it('moderators can hide/label/suspend but cannot change policy, invites, allowlist or regex', async () => {
    await sql`UPDATE lens_web.instance_admins SET role = 'moderator' WHERE address = ${owner}`;
    expect((await setConfig(request('/api/admin/config', { moderation: {} }))).status).toBe(404);
    for (const body of [
      { action: 'allowlist', addresses: [owner] },
      {
        action: 'invites',
        count: 1,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      {
        action: 'filter',
        filter: { kind: 'regex', pattern: 'spam', action: 'hide', reason: 'spam' },
      },
    ]) {
      expect((await adminAction(request('/api/admin/moderation', body))).status).toBe(404);
    }
    for (const operation of ['hide', 'label', 'suspend'])
      expect(
        (
          await adminAction(
            request('/api/admin/moderation', {
              action: 'account',
              target: account,
              operation,
              reason: 'reviewed',
            })
          )
        ).status
      ).toBe(200);
    expect(
      await sql`SELECT * FROM lens_web.audit_log WHERE action = 'moderation.account'`
    ).toHaveLength(3);
  });
  it('adds role limits on top of the global limiter and records policy updates', async () => {
    await registerMember(account, owner);
    await policy({ memberRate: 1 });
    await assertSponsorPolicy(owner, account);
    await expect(assertSponsorPolicy(owner, account)).rejects.toMatchObject({ status: 429 });
    expect(
      await sql`SELECT * FROM lens_web.audit_log WHERE action = 'moderation.policy'`
    ).toHaveLength(1);
  });
  it('expires the five-second moderation cache and the thirty-second token cache', async () => {
    await registerMember(account, owner);
    await assertAccess(owner, account);
    await sql`UPDATE lens_web.moderation_accounts SET suspended = true WHERE account = ${account}`;
    await assertAccess(owner, account);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5001);
    try {
      await expect(assertAccess(owner, account)).rejects.toMatchObject({ status: 403 });
      const token = { address: '', standard: 'erc20' as const, minimum: '1', tokenId: '0' };
      mocks.read.mockResolvedValue(1n);
      expect(await holdsToken(owner, { ...token, address: other })).toBe(true);
      mocks.read.mockResolvedValue(0n);
      expect(await holdsToken(owner, { ...token, address: other })).toBe(true);
      clock.mockReturnValue(now + 35002);
      expect(await holdsToken(owner, { ...token, address: other })).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['hide', 'unhide', 'hidden'],
    ['suspend', 'unsuspend', 'suspended'],
    ['approve', 'unapprove', 'approved'],
    ['revoke', 'restore', 'sponsor_revoked'],
    ['label', 'unlabel', 'label'],
  ])('records and reverses account %s', async (operation, reverse, column) => {
    await action({ action: 'account', target: account, operation, reason: 'reviewed' });
    expect(
      (await sql`SELECT * FROM lens_web.moderation_accounts WHERE account = ${account}`)[0]![
        column!
      ]
    ).toBe(operation === 'label' ? 'reviewed' : true);
    await action({ action: 'account', target: account, operation: reverse, reason: 'appeal' });
    expect(
      (await sql`SELECT * FROM lens_web.moderation_accounts WHERE account = ${account}`)[0]![
        column!
      ]
    ).toBe(operation === 'label' ? null : false);
    expect(
      await sql`SELECT * FROM lens_web.audit_log WHERE action = 'moderation.account'`
    ).toHaveLength(2);
  });

  it('resolves reports with suspend/dismiss and includes the author in account history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ post: postView('55') }))
    );
    for (const target of ['55', '56'])
      await report(request('/api/reports', { targetType: 'post', target, reason: 'harassment' }));
    const reports =
      await sql`SELECT id::text, target FROM lens_web.moderation_reports ORDER BY target`;
    await action({
      action: 'reports',
      ids: [reports[0]!.id],
      operation: 'suspend',
      reason: 'reviewed',
    });
    await action({
      action: 'reports',
      ids: [reports[1]!.id],
      operation: 'dismiss',
      reason: 'no violation',
    });
    expect((await moderationSnapshot()).accounts.get(account)?.suspended).toBe(true);
    expect(
      await sql`SELECT * FROM lens_web.audit_log WHERE details->>'target' = ${account} AND action = 'moderation.account'`
    ).toHaveLength(1);
    expect(
      (await sql`SELECT status FROM lens_web.moderation_reports WHERE target = '56'`)[0]!.status
    ).toBe('dismissed');
  });

  it('measures warmed relay moderation with cached state and real Postgres rate limiting', async () => {
    await registerMember(account, owner);
    await policy({ memberRate: 10000 });
    await action({
      action: 'filter',
      filter: { kind: 'regex', pattern: '\\bspam\\b', action: 'block', reason: 'spam' },
    });
    const call = createPost(
      contracts.LensGlobalFeed,
      account,
      toDataURI(textOnlyPost('A normal community post.'))
    );
    await assertSponsorPolicy(owner, account);
    await assertRelayContent(call.target, call.data);
    const times = [];
    for (let i = 0; i < 300; i++) {
      const start = performance.now();
      await assertRelayContent(call.target, call.data);
      await assertSponsorPolicy(owner, account);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(
      'MODERATION_RELAY_LATENCY',
      JSON.stringify({
        samples: times.length,
        p50: times[150],
        p95: times[285],
        p99: times[297],
        max: times[299],
      })
    );
    expect(times[285]).toBeLessThan(20);
  });
});
