import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { database, migrate, type WriteSql } from './db';

export const SECRET_ENV = {
  resendApiKey: ['RESEND_API_KEY'],
  relayerPrivateKeys: ['RELAYER_PRIVATE_KEYS', 'RELAYER_PRIVATE_KEY'],
  walletConnectProjectId: ['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID'],
  captchaSecret: ['CAPTCHA_SECRET'],
} as const;
export type SecretName = keyof typeof SECRET_ENV;

function encryptionKey(secret = process.env.INSTANCE_SECRET): Buffer {
  if (!secret || secret.length < 32)
    throw new Error('INSTANCE_SECRET must be at least 32 characters');
  return Buffer.from(hkdfSync('sha256', secret, 'lens_web.instance_secrets.v1', 'AES-256-GCM', 32));
}
export function encryptSecret(name: string, value: string, master?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(master), iv);
  cipher.setAAD(Buffer.from(name));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}
export function decryptSecret(name: string, value: string, master?: string): string {
  const [version, iv, tag, ciphertext, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra)
    throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(master),
    Buffer.from(iv, 'base64')
  );
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
export async function getSecret(name: SecretName): Promise<string | undefined> {
  const override = SECRET_ENV[name].map((key) => process.env[key]).find(Boolean);
  if (override) return override;
  return getStoredSecret(name);
}
export async function getStoredSecret(
  name: SecretName,
  connection?: WriteSql
): Promise<string | undefined> {
  if (!connection) {
    const sql = database();
    if (!sql) return undefined;
    await migrate(sql);
    return getStoredSecret(name, sql);
  }
  const [row] =
    await connection`SELECT ciphertext FROM lens_web.instance_secrets WHERE key = ${name}`;
  return row ? decryptSecret(name, row.ciphertext) : undefined;
}
export async function writeSecret(sql: WriteSql, name: SecretName, value: string, actor: string) {
  const ciphertext = encryptSecret(name, value);
  // A relayer key's suffix is unnecessary: show only its public address in the UI.
  const lastFour = name === 'relayerPrivateKeys' ? '' : value.slice(-4);
  await sql`INSERT INTO lens_web.instance_secrets (key, ciphertext, last_four, updated_by)
    VALUES (${name}, ${ciphertext}, ${lastFour}, ${actor}) ON CONFLICT (key) DO UPDATE SET
    ciphertext = excluded.ciphertext, last_four = excluded.last_four, updated_by = excluded.updated_by, updated_at = now()`;
  await sql`INSERT INTO lens_web.audit_log (actor, action, details)
    VALUES (${actor}, 'secret.update', ${sql.json({ key: name })})`;
}
export async function secretStatus() {
  const sql = database();
  if (!sql) return {};
  await migrate(sql);
  const rows = await sql`SELECT key, last_four, updated_at FROM lens_web.instance_secrets`;
  return Object.fromEntries(
    Object.entries(SECRET_ENV).map(([name, envs]) => {
      const override = envs.map((key) => process.env[key]).find(Boolean);
      const row = rows.find((row) => row.key === name);
      return [
        name,
        {
          set: !!override || !!row,
          lastFour:
            name === 'relayerPrivateKeys' ? '' : (override?.slice(-4) ?? row?.last_four ?? ''),
          updatedAt: row?.updated_at ?? null,
          overridden: !!override,
        },
      ];
    })
  );
}
