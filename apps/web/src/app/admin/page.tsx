import { notFound } from 'next/navigation';
import { checkHealth } from '@/lib/server/health';
import { adminDatabase, findAdmin } from '@/lib/server/admin';
import { AdminPreferences } from '@/components/admin-team';
export default async function OverviewPage() {
  const admin = await findAdmin();
  if (!admin) notFound();
  const [health, [counts]] = await Promise.all([
    checkHealth(),
    adminDatabase()`SELECT count(*)::int AS count FROM lens_web.signups WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  ]);
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <h2 className="text-2xl">Overview</h2>
      <p className={health.healthy ? 'text-status-success' : 'text-status-error'}>
        {health.healthy ? 'Healthy' : 'Needs attention'}
        {health.paused ? ' · Sponsorship paused' : ''}
      </p>
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
