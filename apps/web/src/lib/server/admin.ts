import { isAddress, type Address } from 'viem';
import { database, migrate, type Sql } from './db';
import { HttpError } from './guard';
import { getSession } from './session';
import { indexerUrl } from './env';

export type AdminRole = 'owner' | 'admin' | 'moderator';
export type Admin = { address: string; role: AdminRole; email: string | null; alerts: boolean };
export function roleAllowed(
  role: AdminRole | undefined,
  scope: 'read' | 'config' | 'team' | 'moderation'
) {
  if (!role) return false;
  if (scope === 'read' || scope === 'moderation') return true;
  if (scope === 'team') return role === 'owner';
  return role === 'owner' || role === 'admin';
}
export async function findAdmin(): Promise<Admin | null> {
  const { owner } = await getSession();
  const sql = database();
  if (!owner || !sql) return null;
  await migrate(sql);
  const [row] = await sql<
    Admin[]
  >`SELECT address, role, email, alerts FROM lens_web.instance_admins WHERE address = ${owner.toLowerCase()}`;
  return row ?? null;
}
export async function requireAdmin(
  scope: 'read' | 'config' | 'team' | 'moderation' = 'read'
): Promise<Admin> {
  const admin = await findAdmin();
  if (!admin || !roleAllowed(admin.role, scope)) throw new HttpError(404, 'Not found');
  return admin;
}
export function adminDatabase(): Sql {
  const sql = database();
  if (!sql) throw new HttpError(503, 'Set DATABASE_URL to administer this instance');
  return sql;
}
export async function resolveWallet(value: string): Promise<Address> {
  if (isAddress(value)) return value;
  const response = await fetch(
    `${indexerUrl()}/accounts/${encodeURIComponent(value.replace(/^@/, ''))}`,
    { cache: 'no-store', signal: AbortSignal.timeout(5000) }
  );
  if (!response.ok) throw new HttpError(400, 'Username not found');
  const data = await response.json();
  const { ownerOf } = await import('./chain');
  const owner = data.account?.address && (await ownerOf(data.account.address));
  if (!owner) throw new HttpError(400, 'Could not resolve this account’s owner');
  return owner;
}
