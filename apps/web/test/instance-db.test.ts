import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDatabase, TEST_DATABASE_URL } from './helpers';
import type { Sql } from '../src/lib/server/db';

let sql: Sql;
const { send, session, health } = vi.hoisted(() => ({
  send: vi.fn(),
  session: vi.fn().mockResolvedValue({}),
  health: vi.fn(),
}));
vi.mock('../src/lib/server/db', async (original) => ({
  ...(await original<typeof import('../src/lib/server/db')>()),
  database: () => sql ?? null,
}));
vi.mock('../src/lib/server/email', () => ({ sendEmail: send }));
vi.mock('../src/lib/server/session', () => ({ getSession: session }));
vi.mock('../src/lib/server/health', () => ({ checkHealth: health }));
vi.mock('../src/lib/server/accounts', () => ({
  accountsOwnedBy: async () => ['0x0000000000000000000000000000000000000001'],
}));
import { migrate } from '../src/lib/server/db';
import { recordDirectSignup } from '../src/lib/server/signups';
import { claimOwner, setupStatus } from '../src/lib/server/setup';
import {
  getInstanceConfig,
  invalidateInstanceConfig,
  writeConfig,
} from '../src/lib/server/instance-config';
import { getSecret, writeSecret, secretStatus } from '../src/lib/server/secrets';
import {
  subscribeEmail,
  unsubscribeEmail,
  verifyEmail,
  notifyAdmins,
  runDigests,
  runOperatorAlerts,
} from '../src/lib/server/notifications-email';
import { isPaused, assertSponsorshipAvailable } from '../src/lib/server/guard';

const OWNER = '0x0000000000000000000000000000000000000001';
const tables = [
  'instance_setup',
  'instance_config',
  'instance_admins',
  'instance_secrets',
  'audit_log',
  'email_subscriptions',
  'alert_state',
  'signups',
];

describe.skipIf(!TEST_DATABASE_URL)('instance state in real Postgres', () => {
  beforeAll(async () => {
    sql = testDatabase();
    await migrate(sql);
  });
  beforeEach(async () => {
    for (const table of tables) await sql.unsafe(`TRUNCATE lens_web.${table}`);
    invalidateInstanceConfig();
    vi.stubEnv('DATABASE_URL', TEST_DATABASE_URL!);
    vi.stubEnv('INSTANCE_SECRET', 'anvil-test-instance-master-secret-32-characters');
    vi.stubEnv('SETUP_TOKEN', 'anvil-test-setup-token');
    send.mockResolvedValue({ id: 'mock-message' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    session.mockResolvedValue({});
  });
  afterAll(async () => {
    if (sql) {
      for (const table of tables) await sql.unsafe(`TRUNCATE lens_web.${table}`);
      await sql.end();
    }
  });

  it('claims the owner once under concurrent requests and closes setup when completed', async () => {
    expect(await setupStatus()).toMatchObject({ claimed: false, completed: false });
    await expect(claimOwner(sql, OWNER, 'incorrect')).rejects.toMatchObject({ status: 401 });
    const claims = await Promise.allSettled([
      claimOwner(sql, OWNER, 'anvil-test-setup-token'),
      claimOwner(sql, '0x0000000000000000000000000000000000000002', 'anvil-test-setup-token'),
    ]);
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(await sql`SELECT * FROM lens_web.instance_admins WHERE role = 'owner'`).toHaveLength(1);
    expect(await setupStatus()).toMatchObject({ claimed: true, completed: false });
    await expect(claimOwner(sql, OWNER, 'anvil-test-setup-token')).rejects.toMatchObject({
      status: 404,
    });
    await sql`UPDATE lens_web.instance_setup SET completed_at = now()`;
    expect(await setupStatus()).toMatchObject({ claimed: true, completed: true });
    const [audit] = await sql`SELECT action FROM lens_web.audit_log`;
    expect(audit!.action).toBe('setup.claim');
  });

  it('allows a retained teammate to claim after reset, and restricts completion to the owner once', async () => {
    await setupStatus();
    await sql`INSERT INTO lens_web.instance_admins (address, role) VALUES (${OWNER}, 'admin')`;
    session.mockResolvedValue({ owner: OWNER });
    const { PUT, GET } = await import('../src/app/api/setup/route');
    const finish = () =>
      PUT(
        new Request('http://localhost/api/setup', {
          method: 'PUT',
          headers: {
            origin: 'http://localhost',
            host: 'localhost',
            'content-type': 'application/json',
          },
          body: '{}',
        })
      );
    expect((await finish()).status).toBe(404);
    await claimOwner(sql, OWNER, 'anvil-test-setup-token');
    expect(
      (await sql`SELECT role FROM lens_web.instance_admins WHERE address = ${OWNER}`)[0]!.role
    ).toBe('owner');
    const member = '0x0000000000000000000000000000000000000002';
    await sql`INSERT INTO lens_web.instance_admins (address, role) VALUES (${member}, 'admin')`;
    session.mockResolvedValue({ owner: member });
    expect((await GET()).status).toBe(404);
    expect((await finish()).status).toBe(404);
    session.mockResolvedValue({ owner: OWNER });
    expect((await finish()).status).toBe(200);
    expect((await finish()).status).toBe(404);
    expect((await GET()).status).toBe(404);
  });

  it('generates and logs a token only on the first boot across concurrent instances', async () => {
    vi.stubEnv('SETUP_TOKEN', '');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await Promise.all([setupStatus(), setupStatus(), setupStatus()]);
    expect(log).toHaveBeenCalledTimes(1);
    const token = log.mock.calls[0]![1] as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await claimOwner(sql, OWNER, token);
    log.mockRestore();
  });

  it('keeps patches focused, increments versions and changes pause and budget without restarting', async () => {
    await sql.begin(async (tx) =>
      writeConfig(tx, { appName: 'Community', sponsorGasBudgetPerHour: '50000000' }, OWNER)
    );
    invalidateInstanceConfig();
    expect((await getInstanceConfig()).appName).toBe('Community');
    expect(await sql`SELECT key FROM lens_web.instance_config`).toHaveLength(2);
    await sql.begin(async (tx) => writeConfig(tx, { relayPaused: true }, OWNER));
    // Other processes keep their snapshot until its cache expires.
    expect(isPaused()).toBe(false);
    invalidateInstanceConfig();
    await getInstanceConfig();
    expect(isPaused()).toBe(true);
    expect(() => assertSponsorshipAvailable()).toThrow('Community');
    vi.stubEnv('RELAY_PAUSED', 'false');
    expect(isPaused()).toBe(false);
    vi.stubEnv('APP_NAME', 'Environment');
    expect((await getInstanceConfig()).appName).toBe('Environment');
    await sql.begin(async (tx) => writeConfig(tx, { relayPaused: false }, OWNER));
    const [row] = await sql`SELECT version FROM lens_web.instance_config WHERE key = 'relayPaused'`;
    expect(row!.version).toBe(2);
    const audit = await sql`SELECT details FROM lens_web.audit_log`;
    expect(audit).toHaveLength(3);
  });

  it('stores an unset gas budget as JSON null, and refreshes other instances after ten seconds', async () => {
    await sql.begin(async (tx) => writeConfig(tx, { sponsorGasBudgetPerHour: null }, OWNER));
    invalidateInstanceConfig();
    expect((await getInstanceConfig()).sponsorGasBudgetPerHour).toBeNull();
    const time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
    try {
      await sql.begin(async (tx) =>
        writeConfig(tx, { sponsorGasBudgetPerHour: '20000000' }, OWNER)
      );
      expect((await getInstanceConfig()).sponsorGasBudgetPerHour).toBeNull();
      clock.mockReturnValue(time + 10_001);
      expect((await getInstanceConfig()).sponsorGasBudgetPerHour).toBe('20000000');
    } finally {
      clock.mockRestore();
    }
  });

  it('rolls config and audit changes back together', async () => {
    await expect(
      sql.begin(async (tx) => {
        await writeConfig(tx, { appName: 'Rollback' }, OWNER);
        throw new Error('abort');
      })
    ).rejects.toThrow('abort');
    expect(await sql`SELECT * FROM lens_web.instance_config`).toHaveLength(0);
    expect(await sql`SELECT * FROM lens_web.audit_log`).toHaveLength(0);
  });

  it('preserves email preferences when the owner changes a role without preference fields', async () => {
    const member = '0x0000000000000000000000000000000000000002';
    await sql`INSERT INTO lens_web.instance_admins (address, role, email, alerts) VALUES (${OWNER}, 'owner', 'owner@example.com', true), (${member}, 'admin', 'admin@example.com', true)`;
    session.mockResolvedValue({ owner: OWNER });
    const { PUT } = await import('../src/app/api/admin/team/route');
    for (const address of [member, OWNER]) {
      const response = await PUT(
        new Request('http://localhost/api/admin/team', {
          method: 'PUT',
          headers: {
            origin: 'http://localhost',
            host: 'localhost',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ address, role: 'moderator' }),
        })
      );
      expect(response.status).toBe(200);
    }
    const rows =
      await sql`SELECT address, role, email, alerts FROM lens_web.instance_admins ORDER BY address`;
    expect(rows).toEqual([
      { address: OWNER, role: 'owner', email: 'owner@example.com', alerts: true },
      { address: member, role: 'moderator', email: 'admin@example.com', alerts: true },
    ]);
    expect(await sql`SELECT * FROM lens_web.audit_log WHERE action = 'team.update'`).toHaveLength(
      2
    );
  });

  it('stores encrypted secrets, returns metadata only, and prefers env overrides', async () => {
    await sql.begin(async (tx) => writeSecret(tx, 'resendApiKey', 'mock-provider-key-1234', OWNER));
    const [row] = await sql`SELECT ciphertext FROM lens_web.instance_secrets`;
    expect(row!.ciphertext).not.toContain('mock-provider-key');
    expect(await getSecret('resendApiKey')).toBe('mock-provider-key-1234');
    expect((await secretStatus()).resendApiKey).toMatchObject({
      set: true,
      lastFour: '1234',
      overridden: false,
    });
    expect(JSON.stringify(await secretStatus())).not.toContain('mock-provider-key');
    vi.stubEnv('RESEND_API_KEY', 'mock-env-value');
    expect(await getSecret('resendApiKey')).toBe('mock-env-value');
    expect((await secretStatus()).resendApiKey!.overridden).toBe(true);
    expect(
      JSON.stringify(await sql`SELECT actor, action, details FROM lens_web.audit_log`)
    ).not.toContain('mock-provider-key');
  });

  async function emailConfig() {
    await sql.begin(async (tx) => {
      await writeConfig(
        tx,
        {
          appUrl: 'https://community.example',
          emailFrom: 'hello@example.com',
          userEmailEnabled: true,
        },
        OWNER
      );
      await writeSecret(tx, 'resendApiKey', 'mock-test-key', OWNER);
    });
    invalidateInstanceConfig();
    await getInstanceConfig();
  }
  it('uses expiring single-use email confirmation and token-authorized unsubscribe', async () => {
    await emailConfig();
    await subscribeEmail(OWNER, 'user@example.com', 'daily');
    const message = send.mock.calls[0]![0];
    const token = /verify\?token=([0-9a-f]{64})/.exec(message.text)![1]!;
    const unsubscribe = new URL(message.unsubscribe).searchParams.get('token')!;
    expect((await sql`SELECT verified FROM lens_web.email_subscriptions`)[0]!.verified).toBe(false);
    expect(await verifyEmail('f'.repeat(64))).toBe(false);
    expect(await verifyEmail(token)).toBe(true);
    expect(await verifyEmail(token)).toBe(false);
    await unsubscribeEmail('f'.repeat(64));
    expect(await sql`SELECT * FROM lens_web.email_subscriptions`).toHaveLength(1);
    await unsubscribeEmail(unsubscribe);
    expect(await sql`SELECT * FROM lens_web.email_subscriptions`).toHaveLength(0);
    await subscribeEmail(OWNER, 'user@example.com', 'weekly');
    const expired = /verify\?token=([0-9a-f]{64})/.exec(send.mock.calls.at(-1)![0].text)![1]!;
    await sql`UPDATE lens_web.email_subscriptions SET verify_expires_at = now() - interval '1 minute'`;
    expect(await verifyEmail(expired)).toBe(false);
  });

  it('records wallet-paid signups using their indexed creation time, without counting twice', async () => {
    const seconds = Math.floor(Date.now() / 1000) - 30;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () => Response.json({ account: { createdAt: String(seconds) } }))
    );
    await recordDirectSignup(OWNER);
    await recordDirectSignup(OWNER);
    const rows = await sql`SELECT * FROM lens_web.signups WHERE account = ${OWNER}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_at.getTime()).toBe(seconds * 1000);
  });

  it('waits for five minutes of degraded health and resets the observation after recovery', async () => {
    await emailConfig();
    await sql`INSERT INTO lens_web.instance_admins (address, role, email, alerts) VALUES (${OWNER}, 'owner', 'admin@example.com', true)`;
    const state = { healthy: false, relayers: [], gas: { budgetPerHour: null, usedThisHour: '0' } };
    health.mockResolvedValue(state);
    await runOperatorAlerts();
    expect(send).not.toHaveBeenCalled();
    await sql`UPDATE lens_web.alert_state SET first_seen = now() - interval '6 minutes' WHERE type = 'health_degraded'`;
    await runOperatorAlerts();
    expect(send).toHaveBeenCalledTimes(1);
    state.healthy = true;
    await runOperatorAlerts();
    expect(
      (await sql`SELECT first_seen FROM lens_web.alert_state WHERE type = 'health_degraded'`)[0]!
        .first_seen
    ).toBeNull();
    state.healthy = false;
    await runOperatorAlerts();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends due verified digests once across concurrent cron invocations', async () => {
    await emailConfig();
    await subscribeEmail(OWNER, 'user@example.com', 'weekly');
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          {
            createdAt: String(Math.floor(Date.now() / 1000)),
            type: 'follow',
            actor: { username: 'alice', address: OWNER },
            post: null,
          },
        ],
        next: null,
      })
    );
    vi.stubGlobal('fetch', fetcher);
    await sql`UPDATE lens_web.email_subscriptions SET sent_at = now() - interval '8 days'`;
    expect(await runDigests()).toEqual({ processed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    await sql`UPDATE lens_web.email_subscriptions SET verified = true`;
    const results = await Promise.all([runDigests(), runDigests()]);
    expect(results.reduce((n, result) => n + result.processed, 0)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2); // Confirmation, then one digest.
    const digest = send.mock.calls[1]![0];
    expect(digest.text).toContain('alice: follow');
    expect(digest.unsubscribe).toContain('/api/email/unsubscribe?token=');
    expect(digest.idempotencyKey).toContain('digest-');
    await unsubscribeEmail(new URL(digest.unsubscribe).searchParams.get('token')!);
    expect(await sql`SELECT * FROM lens_web.email_subscriptions`).toHaveLength(0);
  });

  it('keeps successful digests committed when a later recipient fails, then retries only the failure', async () => {
    await emailConfig();
    const second = '0x0000000000000000000000000000000000000002';
    await subscribeEmail(OWNER, 'first@example.com', 'daily');
    await subscribeEmail(second, 'second@example.com', 'daily');
    await sql`UPDATE lens_web.email_subscriptions SET verified = true, sent_at = now() - interval '2 days'`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          items: [
            {
              createdAt: String(Math.floor(Date.now() / 1000)),
              type: 'follow',
              actor: { username: 'alice', address: OWNER },
              post: null,
            },
          ],
          next: null,
        })
      )
    );
    send
      .mockResolvedValueOnce({ id: 'sent' })
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runDigests()).toEqual({ processed: 1 });
      expect(
        await sql`SELECT owner FROM lens_web.email_subscriptions WHERE sent_at > now() - interval '1 day'`
      ).toHaveLength(1);
      expect(await runDigests()).toEqual({ processed: 1 });
      expect(send).toHaveBeenCalledTimes(5); // Two confirmations, one successful delivery, one failure, one retry.
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('reserves the alert debounce even when the provider fails', async () => {
    await emailConfig();
    await sql`INSERT INTO lens_web.instance_admins (address, role, email, alerts) VALUES (${OWNER}, 'owner', 'admin@example.com', true)`;
    send.mockRejectedValueOnce(new Error('provider unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await notifyAdmins('new_reports', { count: 1 });
      await notifyAdmins('new_reports', { count: 2 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('requires opt-in and sends at most one alert per type per hour across concurrent requests', async () => {
    await emailConfig();
    await sql`INSERT INTO lens_web.instance_admins (address, role, email, alerts) VALUES (${OWNER}, 'owner', 'admin@example.com', true), ('0x0000000000000000000000000000000000000002', 'admin', 'off@example.com', false)`;
    await Promise.all([
      notifyAdmins('new_reports', { count: 1 }),
      notifyAdmins('new_reports', { count: 2 }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].to).toBe('admin@example.com');
    await notifyAdmins('new_reports', { count: 3 });
    expect(send).toHaveBeenCalledTimes(1);
    await sql`UPDATE lens_web.alert_state SET sent_at = now() - interval '61 minutes'`;
    await notifyAdmins('new_reports', { count: 4 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
