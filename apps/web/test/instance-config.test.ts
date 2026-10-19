import { describe, expect, it } from 'vitest';
import {
  InstanceConfig,
  resolveConfig,
  publicConfig,
  CONFIG_ENV,
} from '../src/lib/instance-schema';
import { encryptSecret, decryptSecret } from '../src/lib/server/secrets';

describe('instance config', () => {
  it('uses defaults, database values, then environment overrides, including false', () => {
    expect(resolveConfig({}, {}).appName).toBe('Parallax');
    expect(resolveConfig({ appName: 'Community', relayPaused: true }, {}).appName).toBe(
      'Community'
    );
    const config = resolveConfig(
      { appName: 'DB', relayPaused: true, sponsorGasBudgetPerHour: '100' },
      {
        APP_NAME: 'Environment',
        RELAY_PAUSED: 'false',
        SPONSOR_GAS_BUDGET_PER_HOUR: '50_000_000',
        RELAY_RATE_LIMIT_PER_MINUTE: '7',
        RPC_URL: 'https://private.example/rpc',
      }
    );
    expect(config).toMatchObject({
      appName: 'Environment',
      relayPaused: false,
      sponsorGasBudgetPerHour: '50000000',
      relayRateLimitPerMinute: 7,
    });
    expect(publicConfig(config)).not.toHaveProperty('serverRpcUrl');
    expect(publicConfig(config)).not.toHaveProperty('indexerUrl');
  });
  it('prefers APP_URL over the legacy name and ignores empty bootstrap values', () => {
    expect(
      resolveConfig(
        {},
        { APP_URL: 'https://new.example', NEXT_PUBLIC_APP_URL: 'https://old.example' }
      ).appUrl
    ).toBe('https://new.example');
    expect(resolveConfig({ appName: 'DB' }, { APP_NAME: '' }).appName).toBe('DB');
  });
  it('validates every runtime key and rejects unsafe values', () => {
    expect(Object.keys(CONFIG_ENV).sort()).toEqual(Object.keys(InstanceConfig.parse({})).sort());
    for (const input of [
      { appUrl: 'javascript:alert(1)' },
      { logoUrl: 'data:text/html,x' },
      { accentColor: '</style>' },
      { relayRateLimitPerMinute: 0 },
      { sponsorGasBudgetPerHour: '-1' },
      { sponsorRouter: 'bad' },
      { unknown: 1 },
    ]) {
      expect(() => InstanceConfig.parse(input)).toThrow();
    }
    expect(() => resolveConfig({}, { SPONSOR_MAX_GAS_PER_TX: 'bad' })).toThrow(
      'SPONSOR_MAX_GAS_PER_TX'
    );
  });
  it('writes partial patches without supplying defaults for omitted fields', () => {
    expect(InstanceConfig.partial().parse({ appName: 'Changed' })).toEqual({ appName: 'Changed' });
  });
});

describe('encrypted secrets', () => {
  const key = 'test-instance-master-secret-32-characters';
  it('round trips with a fresh IV and never stores plaintext', () => {
    const value = 'test-provider-token';
    const a = encryptSecret('resendApiKey', value, key);
    const b = encryptSecret('resendApiKey', value, key);
    expect(a).not.toBe(b);
    expect(a).not.toContain(value);
    expect(decryptSecret('resendApiKey', a, key)).toBe(value);
  });
  it('detects ciphertext/tag tampering, wrong context and wrong master keys', () => {
    const original = encryptSecret('resendApiKey', 'test-provider-token', key);
    for (const index of [1, 2, 3]) {
      const parts = original.split('.');
      const bytes = Buffer.from(parts[index]!, 'base64');
      bytes[0] = bytes[0]! ^ 1;
      parts[index] = bytes.toString('base64');
      expect(() => decryptSecret('resendApiKey', parts.join('.'), key)).toThrow();
    }
    expect(() => decryptSecret('relayerPrivateKeys', original, key)).toThrow();
    expect(() => decryptSecret('resendApiKey', original, `${key}wrong`)).toThrow();
    expect(() => encryptSecret('resendApiKey', 'value', 'short')).toThrow('INSTANCE_SECRET');
  });
});
