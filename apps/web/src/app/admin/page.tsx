import Link from 'next/link';
import { notFound } from 'next/navigation';
import { checkHealth } from '@/lib/server/health';
import { adminDatabase, findAdmin, roleAllowed } from '@/lib/server/admin';
import { getInstanceConfig } from '@/lib/server/instance-config';
import { secretStatus } from '@/lib/server/secrets';
import { setupChecklist, type ChecklistStatus } from '@/lib/admin-checklist';
import { sectionsFor } from '@/lib/admin-sections';
import { AdminPreferences } from '@/components/admin-team';
import { Icon } from '@/components/icons';

const STATUS: Record<ChecklistStatus, { mark: string; label: string; className: string }> = {
  done: { mark: '✓', label: 'Done', className: 'text-status-success' },
  todo: { mark: '!', label: 'To do', className: 'text-status-error' },
  optional: { mark: '○', label: 'Optional', className: 'text-text-tertiary' },
};
export default async function OverviewPage() {
  const admin = await findAdmin();
  if (!admin) notFound();
  const configures = roleAllowed(admin.role, 'config');
  const sections = sectionsFor(admin.role);
  const sql = adminDatabase();
  const [health, [counts], config, secrets, [team]] = await Promise.all([
    checkHealth(),
    sql`SELECT count(*)::int AS count FROM lens_web.signups WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    getInstanceConfig(),
    configures ? secretStatus() : Promise.resolve({} as Awaited<ReturnType<typeof secretStatus>>),
    sql`SELECT count(*)::int AS count FROM lens_web.instance_admins`,
  ]);
  // Moderators don't change settings: they see the sections they can open, not the checklist.
  const reachable = new Set(sections.map((section) => `/admin/${section.slug}`));
  const checklist = configures
    ? setupChecklist({
        config,
        health,
        resendKeySet: !!secrets.resendApiKey?.set,
        teamSize: team!.count,
      }).filter((item) => reachable.has(item.href))
    : [];
  const todo = checklist.filter((item) => item.status === 'todo').length;
  return (
    <div className="space-y-8 p-4 sm:p-6">
      <div className="space-y-2">
        <h2 className="text-2xl">Overview</h2>
        <p className={health.healthy ? 'text-status-success' : 'text-status-error'}>
          {health.healthy ? 'Healthy' : 'Needs attention'}
          {health.paused ? ' · Sponsorship paused' : ''}
        </p>
      </div>
      {checklist.length > 0 && (
        <section aria-labelledby="checklist" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="checklist" className="text-xl">
              Setup checklist
            </h3>
            <p className="text-sm text-text-secondary">
              {todo === 0
                ? 'Everything essential is done.'
                : `${todo} thing${todo === 1 ? '' : 's'} left to do.`}
            </p>
          </div>
          <ul className="divide-y divide-border-default border border-border-default">
            {checklist.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="focus-ring flex items-start gap-3 p-3 hover:bg-bg-hover"
                >
                  <span aria-hidden className={`w-4 font-mono ${STATUS[item.status].className}`}>
                    {STATUS[item.status].mark}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-text-primary">
                      {item.label}
                      <span className="sr-only"> ({STATUS[item.status].label})</span>
                    </span>
                    <span className="block text-sm text-text-secondary">{item.detail}</span>
                  </span>
                  <Icon name="back" size={16} className="mt-0.5 rotate-180 text-text-tertiary" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="sections" className="space-y-3">
        <h3 id="sections" className="text-xl">
          Admin panel
        </h3>
        <ul className="grid gap-3 sm:grid-cols-2">
          {sections.map((section) => (
            <li key={section.slug}>
              <Link
                href={`/admin/${section.slug}`}
                className="focus-ring block h-full border border-border-default p-3 hover:bg-bg-hover"
              >
                <span className="block font-mono text-xs text-text-primary uppercase">
                  {section.label}
                </span>
                <span className="mt-1 block text-sm text-text-secondary">
                  {section.description}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <h3 className="text-xl">Status</h3>
      <dl className="grid grid-cols-2 gap-4 text-sm">
        {[
          ['Gas used this hour', health.gas.usedThisHour ?? 'Unavailable'],
          ['Hourly gas budget', health.gas.budgetPerHour ?? 'Unset'],
          ['Indexer lag (blocks)', health.indexer.lag ?? 'Unavailable'],
          ['Signups today (UTC)', counts!.count],
          ['Chain', health.chainId],
          ['Database', health.database?.ok ? 'Connected' : 'Unavailable'],
        ].map(([label, value]) => (
          <div key={label} className="border border-border-default p-3">
            <dt className="text-text-secondary">{label}</dt>
            <dd className="mt-2 break-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {health.problems.length > 0 && (
        <ul className="list-inside list-disc space-y-2 text-sm">
          {health.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <section className="space-y-3">
        <h3 className="text-xl">Relayers</h3>
        {health.relayers.map((relayer) => (
          <div
            key={relayer.address}
            className="break-all border-b border-border-default pb-3 text-sm"
          >
            <p className="font-mono text-xs">{relayer.address}</p>
            <p>
              {relayer.balance ?? 'Unknown'} MON ·{' '}
              {relayer.allowlisted ? 'Allowlisted' : 'Not allowlisted'}
            </p>
          </div>
        ))}
      </section>
      <AdminPreferences admin={admin} />
    </div>
  );
}
