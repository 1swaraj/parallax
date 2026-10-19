import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceConfig } from '../src/lib/instance-schema';
const { send, list, get, secret, config } = vi.hoisted(() => ({
  send: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  secret: vi.fn(),
  config: vi.fn(),
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
    domains = { list, get };
  },
}));
vi.mock('../src/lib/server/secrets', () => ({ getSecret: secret }));
vi.mock('../src/lib/server/instance-config', () => ({ getInstanceConfig: config }));
import { sendEmail, checkEmailDomain } from '../src/lib/server/email';

beforeEach(() => {
  config.mockResolvedValue(
    InstanceConfig.parse({
      appName: 'Community',
      emailFrom: 'hello@example.com',
      emailDomain: 'example.com',
    })
  );
  secret.mockResolvedValue('mock-resend-key');
  send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
});
afterEach(() => vi.clearAllMocks());
describe('official Resend client', () => {
  it('sends a plain branded template with RFC 8058 unsubscribe and idempotency headers', async () => {
    await sendEmail({
      to: 'user@example.com',
      subject: 'Digest',
      text: 'Your notifications',
      unsubscribe: 'https://app.example/unsubscribe?token=abc',
      idempotencyKey: 'digest-1',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'hello@example.com',
        to: 'user@example.com',
        subject: 'Community: Digest',
        text: expect.stringContaining('Community\n'),
        headers: {
          'List-Unsubscribe': '<https://app.example/unsubscribe?token=abc>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
      { idempotencyKey: 'digest-1', signal: expect.any(AbortSignal) }
    );
    expect(send.mock.calls[0]![0].text).toContain('Unsubscribe:');
    expect(send.mock.calls[0]![0]).not.toHaveProperty('html');
  });
  it('does not send when unconfigured and never returns provider error details', async () => {
    secret.mockResolvedValueOnce(undefined);
    await expect(sendEmail({ to: 'a@example.com', subject: 'test', text: 'test' })).rejects.toThrow(
      'Email is not configured'
    );
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ error: { name: 'validation_error', message: 'secret response' } });
    await expect(sendEmail({ to: 'a@example.com', subject: 'test', text: 'test' })).rejects.toThrow(
      'validation_error'
    );
  });
  it('finds the configured domain and returns verification and DNS records', async () => {
    list.mockResolvedValue({ data: { data: [{ id: 'domain-1', name: 'example.com' }] } });
    get.mockResolvedValue({
      data: { status: 'pending', records: [{ type: 'TXT', name: '_dmarc', status: 'pending' }] },
    });
    expect(await checkEmailDomain()).toEqual({
      domain: 'example.com',
      status: 'pending',
      records: [{ type: 'TXT', name: '_dmarc', status: 'pending' }],
    });
    expect(get).toHaveBeenCalledWith('domain-1', { signal: expect.any(AbortSignal) });
    list.mockResolvedValue({ data: { data: [] } });
    expect((await checkEmailDomain()).status).toBe('not found');
  });
});
