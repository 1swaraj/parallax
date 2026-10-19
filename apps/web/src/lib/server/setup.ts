import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { database, migrate, type Sql } from './db';
import { HttpError } from './guard';

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function equalToken(token: string, hash: string): boolean {
  return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(hash, 'hex'));
}
export function instanceManaged() {
  return !!process.env.DATABASE_URL && !!process.env.INSTANCE_SECRET;
}
export async function setupStatus() {
  if (!instanceManaged()) return { managed: false, claimed: true, completed: true };
  const sql = database()!;
  await migrate(sql);
  let [state] =
    await sql`SELECT claimed_at, completed_at FROM lens_web.instance_setup WHERE id = 1`;
  if (!state) {
    const token = process.env.SETUP_TOKEN || randomBytes(32).toString('hex');
    const inserted =
      await sql`INSERT INTO lens_web.instance_setup (id, token_hash) VALUES (1, ${tokenHash(token)})
      ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted.length && !process.env.SETUP_TOKEN)
      console.info('Parallax setup token (single use):', token);
    [state] = await sql`SELECT claimed_at, completed_at FROM lens_web.instance_setup WHERE id = 1`;
  }
  return { managed: true, claimed: !!state!.claimed_at, completed: !!state!.completed_at };
}

/** The row lock and single-owner index make claims atomic across server instances. */
export async function claimOwner(sql: Sql, owner: string, token: string) {
  await sql.begin(async (tx) => {
    const [state] =
      await tx`SELECT token_hash, claimed_at FROM lens_web.instance_setup WHERE id = 1 FOR UPDATE`;
    if (!state || state.claimed_at) throw new HttpError(404, 'Not found');
    if (!equalToken(token, state.token_hash)) throw new HttpError(401, 'Invalid setup token');
    await tx`INSERT INTO lens_web.instance_admins (address, role) VALUES (${owner.toLowerCase()}, 'owner') ON CONFLICT (address) DO UPDATE SET role = 'owner'`;
    await tx`UPDATE lens_web.instance_setup SET claimed_at = now(), token_hash = ${tokenHash(randomBytes(32).toString('hex'))} WHERE id = 1`;
    await tx`INSERT INTO lens_web.audit_log (actor, action) VALUES (${owner.toLowerCase()}, 'setup.claim')`;
  });
}
