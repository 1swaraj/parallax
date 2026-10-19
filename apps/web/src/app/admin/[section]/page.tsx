import { notFound } from 'next/navigation';
import { CONFIG_GROUPS } from '@/lib/admin-fields';
import { CONFIG_ENV } from '@/lib/instance-schema';
import { getInstanceConfig } from '@/lib/server/instance-config';
import { findAdmin, adminDatabase, roleAllowed } from '@/lib/server/admin';
import { secretStatus } from '@/lib/server/secrets';
import { AdminEditor, SecretEditor, EmailTools } from '@/components/admin-editor';
import { AdminTeam } from '@/components/admin-team';
import { AdminModeration } from '@/components/admin-moderation';
export default async function AdminSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const admin = await findAdmin();
  if (!admin) notFound();
  if (section === 'moderation' || section === 'moderation-log')
    return (
      <AdminModeration
        role={admin.role}
        policy={
          roleAllowed(admin.role, 'config') ? (await getInstanceConfig()).moderation : undefined
        }
        initialTab={section === 'moderation-log' ? 'Log' : 'Reports'}
      />
    );
  if (!roleAllowed(admin.role, section === 'team' ? 'team' : 'config')) notFound();
  if (section === 'team') {
    const members =
      await adminDatabase()`SELECT address, role, email, alerts FROM lens_web.instance_admins ORDER BY created_at`;
    return (
      <div className="space-y-5 p-4 sm:p-6">
        <h2 className="text-2xl">Team</h2>
        <AdminTeam members={members as never} />
      </div>
    );
  }
  if (section === 'audit') {
    const entries =
      await adminDatabase()`SELECT id::text, actor, action, details, created_at FROM lens_web.audit_log ORDER BY id DESC LIMIT 100`;
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <h2 className="text-2xl">Audit log</h2>
        <p className="text-sm text-text-secondary">
          Latest 100 entries. Older entries are available from /api/admin/audit?before=&lt;id&gt;.
        </p>
        <ol className="divide-y divide-border-default">
          {entries.map((entry) => (
            <li key={entry.id} className="space-y-1 break-all py-4 text-xs">
              <p className="font-mono">
                #{entry.id} · {new Date(entry.created_at).toISOString()} · {entry.action}
              </p>
              <p>{entry.actor}</p>
              <p>{JSON.stringify(entry.details)}</p>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  const group = CONFIG_GROUPS[section];
  if (!group) notFound();
  const config = await getInstanceConfig();
  const overrides = Object.entries(CONFIG_ENV)
    .filter(([, names]) => names.some((name) => !!process.env[name]))
    .map(([key]) => key);
  const secrets = await secretStatus();
  const names =
    section === 'network'
      ? ['walletConnectProjectId']
      : section === 'sponsorship'
        ? ['relayerPrivateKeys']
        : section === 'email'
          ? ['resendApiKey']
          : [];
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <h2 className="text-2xl">{group.title}</h2>
      <AdminEditor key={section} group={section} config={config} overrides={overrides} />
      {names.map((name) => {
        const status = secrets[name];
        return (
          <p key={name} className="text-xs text-text-secondary">
            {name}:{' '}
            {status?.set ? `set${status.lastFour ? ` / …${status.lastFour}` : ''}` : 'not set'}
            {status?.updatedAt ? ` / updated ${new Date(status.updatedAt).toISOString()}` : ''}
            {status?.overridden ? ' / env override' : ''}
          </p>
        );
      })}
      {section === 'network' && (
        <SecretEditor name="walletConnectProjectId" title="WalletConnect project ID" />
      )}
      {section === 'sponsorship' && (
        <SecretEditor
          name="relayerPrivateKeys"
          title="Relayer private keys (comma-separated)"
          generate
        />
      )}
      {section === 'email' && (
        <>
          <SecretEditor name="resendApiKey" title="Resend API key" />
          <EmailTools />
        </>
      )}
    </div>
  );
}
