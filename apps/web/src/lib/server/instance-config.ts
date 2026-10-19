import { InstanceConfig, resolveConfig } from '../instance-schema';
import { database, migrate, type WriteSql } from './db';
export { InstanceConfig } from '../instance-schema';

export const CONFIG_CACHE_MS = 10_000;
let stored: Record<string, unknown> = {};
let expires = 0;
let pending: Promise<void> | undefined;
let generation = 0;

/** Runtime readers use the snapshot loaded at the request boundary; env overrides are always current. */
export function currentConfig(): InstanceConfig {
  return resolveConfig(stored, process.env);
}

export async function getInstanceConfig(): Promise<InstanceConfig> {
  const sql = database();
  if (sql && Date.now() >= expires) {
    const version = generation;
    pending ??= (async () => {
      await migrate(sql);
      const rows = await sql`SELECT key, value FROM lens_web.instance_config`;
      if (version === generation) {
        stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
        expires = Date.now() + CONFIG_CACHE_MS;
      }
    })().finally(() => {
      pending = undefined;
    });
    await pending;
    if (version !== generation || Date.now() >= expires) return getInstanceConfig();
  }
  return currentConfig();
}

export function invalidateInstanceConfig() {
  expires = 0;
  generation++;
}

/** Called inside the administrator's transaction, alongside the audit entry. */
export async function writeConfig(sql: WriteSql, input: unknown, actor: string) {
  const patch = InstanceConfig.partial().parse(input);
  for (const [key, value] of Object.entries(patch)) {
    await sql`INSERT INTO lens_web.instance_config (key, value, updated_by) VALUES (${key}, coalesce(${sql.json(value)}, 'null'::jsonb), ${actor})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, version = lens_web.instance_config.version + 1,
      updated_by = excluded.updated_by, updated_at = now()`;
  }
  await sql`INSERT INTO lens_web.audit_log (actor, action, details) VALUES (${actor}, 'config.update', ${sql.json({ keys: Object.keys(patch) })})`;
  if (patch.moderation)
    await sql`INSERT INTO lens_web.audit_log (actor, action, details) VALUES (${actor}, 'moderation.policy', ${sql.json(patch.moderation)})`;
}
