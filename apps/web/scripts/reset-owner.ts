import { createHash, randomBytes } from 'node:crypto';
import { database, migrate } from '../src/lib/server/db';

if (!process.env.INSTANCE_SECRET || process.env.INSTANCE_SECRET.length < 32) {
  throw new Error('Set INSTANCE_SECRET (32+ characters) and DATABASE_URL first');
}
const sql = database();
if (!sql) throw new Error('Set DATABASE_URL first');
try {
  await migrate(sql);
  const token = randomBytes(32).toString('hex');
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('lens_web:reset-owner', 0))`;
    // Lock the same setup row as claims. Its replacement token closes every previous claim token.
    await tx`SELECT id FROM lens_web.instance_setup WHERE id = 1 FOR UPDATE`;
    await tx`DELETE FROM lens_web.instance_admins WHERE role = 'owner'`;
    await tx`INSERT INTO lens_web.instance_setup (id, token_hash) VALUES (1, ${createHash('sha256').update(token).digest('hex')})
      ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash, claimed_at = NULL, completed_at = NULL`;
    await tx`INSERT INTO lens_web.audit_log (actor, action) VALUES ('cli', 'setup.reset-owner')`;
  });
  console.info('Owner reset. Claim /setup using this single-use token:', token);
  console.info(
    'Other team members and instance settings are retained. SETUP_TOKEN does not replace this token.'
  );
} finally {
  await sql.end();
}
