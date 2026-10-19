'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ModerationPolicy } from '@/lib/moderation-policy';
import type { AdminRole } from '@/lib/server/admin';
import { api } from '@/lib/session';
import { Button } from './ui';
import { Field } from './auth';
import { Choice, ModerationPolicyEditor } from './moderation-policy';

type Report = {
  id: string;
  reporter: string;
  target_type: string;
  target: string;
  reason: string;
  details: string;
  status: string;
};
export type ModerationData = {
  reports: Report[];
  next: string | null;
  log: { id: string; actor: string; action: string; details: unknown; created_at: string }[];
  accounts: {
    account: string;
    reason: string;
    suspended: boolean;
    hidden: boolean;
    sponsor_revoked: boolean;
    approved: boolean;
    label: string | null;
  }[];
  posts: { post_id: string; action: string; reason: string }[];
  filters: { id: string; kind: string; pattern: string; action: string; reason: string }[];
  invites: {
    id: string;
    uses: number;
    max_uses: number;
    expires_at: string;
    created_by: string;
    redeemed: { owner: string; at: string }[];
  }[];
  allowlist: { address: string; added_by: string }[];
};

export function AdminModeration({
  role,
  policy,
  initialTab = 'Reports',
}: {
  role: AdminRole;
  policy?: ModerationPolicy;
  initialTab?: string;
}) {
  const admin = role !== 'moderator';
  const [tab, setTab] = useState(initialTab);
  const [status, setStatus] = useState('open'),
    [filterReason, setFilterReason] = useState('all');
  const [target, setTarget] = useState(''),
    [before, setBefore] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('Reviewed by moderators');
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('word'),
    [pattern, setPattern] = useState(''),
    [filterAction, setFilterAction] = useState('block');
  const [account, setAccount] = useState(''),
    [post, setPost] = useState(''),
    [operation, setOperation] = useState('hide');
  const [csv, setCsv] = useState(''),
    [count, setCount] = useState('10'),
    [maxUses, setMaxUses] = useState('1');
  const [expiry, setExpiry] = useState(''),
    [codes, setCodes] = useState<string[]>([]);
  const query = new URLSearchParams({
    status,
    reason: filterReason,
    target,
    ...(before ? { before } : {}),
  });
  const { data, error, refetch } = useQuery({
    queryKey: ['moderation', query.toString()],
    queryFn: () => api<ModerationData>(`/api/admin/moderation?${query}`),
    refetchInterval: 15000,
  });
  const run = async (body: unknown) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ codes?: string[] }>('/api/admin/moderation', {
        method: 'POST',
        body,
      });
      if (result.codes?.length) setCodes(result.codes);
      setSelected([]);
      await refetch();
      setMessage('Saved to the moderation log.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reportAction = (operation: string, ids = selected) =>
    run({ action: 'reports', ids, operation, reason });
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <h2 className="text-2xl">Moderation</h2>
      <p className="text-sm text-text-secondary">
        Manage this instance’s access, sponsorship and visibility. Hiding affects this instance’s
        reads. Suspending also refuses sign-in and relay here. Lens content stays onchain and can
        appear in other apps.
      </p>
      <nav aria-label="Moderation" className="flex flex-wrap gap-2">
        {[
          'Reports',
          'Accounts & posts',
          'Filters',
          ...(admin ? ['Access & invites', 'Policy'] : []),
          'Log',
        ].map((name) => (
          <Button key={name} onClick={() => setTab(name)} aria-pressed={tab === name}>
            {name}
          </Button>
        ))}
      </nav>
      <p role="status" className="text-sm">
        {message || (error as Error | null)?.message}
      </p>
      {tab === 'Policy' && admin && policy && <ModerationPolicyEditor policy={policy} />}
      {tab !== 'Policy' && (
        <Field
          name="moderationReason"
          label="Action reason / content warning"
          value={reason}
          onChange={setReason}
          maxLength={500}
        />
      )}
      {tab === 'Reports' && (
        <div className="space-y-4">
          <Choice
            label="Report status"
            value={status}
            options={['open', 'resolved', 'dismissed', 'all'].map((v) => [v, v])}
            onChange={(v) => {
              setStatus(v);
              setBefore('');
            }}
          />
          <Choice
            label="Report reason"
            value={filterReason}
            options={['all', 'spam', 'harassment', 'illegal', 'other'].map((v) => [v, v])}
            onChange={(v) => {
              setFilterReason(v);
              setBefore('');
            }}
          />
          <Field
            name="reportTarget"
            label="Filter by account address or post ID"
            value={target}
            onChange={(v) => {
              setTarget(v);
              setBefore('');
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                setSelected(data?.reports.filter((r) => r.status === 'open').map((r) => r.id) ?? [])
              }
            >
              Select all open
            </Button>
            {['hide', 'suspend', 'dismiss'].map((action) => (
              <Button
                key={action}
                disabled={busy || !selected.length || !reason}
                onClick={() => reportAction(action)}
              >
                {action} selected ({selected.length})
              </Button>
            ))}
          </div>
          {data?.reports.length === 0 && <p className="text-sm">No reports match these filters.</p>}
          <ol className="divide-y divide-border-default">
            {data?.reports.map((report) => (
              <li key={report.id} className="space-y-2 break-words py-4 text-sm">
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Select report ${report.id}`}
                    checked={selected.includes(report.id)}
                    disabled={report.status !== 'open'}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, report.id]
                          : ids.filter((id) => id !== report.id)
                      )
                    }
                  />
                  <span>
                    #{report.id} · {report.reason} · {report.status}
                  </span>
                </label>
                <Link
                  className="break-all text-accent-primary underline"
                  href={
                    report.target_type === 'post' ? `/p/${report.target}` : `/u/${report.target}`
                  }
                >
                  {report.target_type}: {report.target}
                </Link>
                <p className="break-all text-xs text-text-secondary">
                  Reported by {report.reporter}
                </p>
                <p>{report.details}</p>
                {report.status === 'open' && (
                  <div className="flex flex-wrap gap-2">
                    {['hide', 'suspend', 'dismiss'].map((action) => (
                      <Button
                        key={action}
                        size="sm"
                        disabled={busy || !reason}
                        onClick={() => reportAction(action, [report.id])}
                      >
                        {action === 'suspend'
                          ? 'Suspend author'
                          : action[0]!.toUpperCase() + action.slice(1)}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {data?.next && (
            <Button
              onClick={() => {
                setBefore(data.next!);
                setSelected([]);
              }}
            >
              Older reports
            </Button>
          )}
          {before && <Button onClick={() => setBefore('')}>Newest reports</Button>}
        </div>
      )}
      {tab === 'Accounts & posts' && (
        <div className="space-y-4">
          <Field
            name="accountTarget"
            label="Lens account or wallet address"
            value={account}
            onChange={setAccount}
          />
          <Choice
            label="Account action"
            value={operation}
            options={[
              'hide',
              'unhide',
              'suspend',
              'unsuspend',
              'label',
              'unlabel',
              ...(admin ? ['approve', 'unapprove', 'revoke', 'restore'] : []),
            ].map((v) => [
              v,
              v === 'revoke' ? 'Revoke sponsorship' : v === 'restore' ? 'Restore sponsorship' : v,
            ])}
            onChange={setOperation}
          />
          <Button
            disabled={busy || !account || !reason}
            onClick={() => run({ action: 'account', target: account.trim(), operation, reason })}
          >
            Apply account action
          </Button>
          <Field name="postTarget" label="Post ID" value={post} onChange={setPost} />
          <div className="flex flex-wrap gap-2">
            {['hide', 'label', 'restore'].map((operation) => (
              <Button
                key={operation}
                disabled={busy || !post || !reason}
                onClick={() => run({ action: 'post', target: post.trim(), operation, reason })}
              >
                {operation} post
              </Button>
            ))}
          </div>
          <ul className="space-y-3 text-xs">
            {data?.accounts.map((a) => (
              <li key={a.account} className="break-all">
                {a.account} ·{' '}
                {[
                  a.hidden && 'hidden',
                  a.suspended && 'suspended',
                  a.approved && 'approved',
                  a.sponsor_revoked && 'sponsorship revoked',
                  a.label && `warning: ${a.label}`,
                ]
                  .filter(Boolean)
                  .join(', ')}
                <p>{a.reason}</p>
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(a.account);
                    setTab('Log');
                  }}
                >
                  Account history
                </Button>
              </li>
            ))}
          </ul>
          <ul className="space-y-2 text-xs">
            {data?.posts.map((p) => (
              <li key={p.post_id}>
                Post {p.post_id}: {p.action} · {p.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'Filters' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            No filters by default. Block refuses relayed text and hides matching posts in reads.
            Hide allows relay but removes posts from reads. Label allows relay and blurs posts
            behind a warning. Moderators use literal words or link domains; only admins create
            regex. Regex uses RE2 syntax, with bounded linear matching. Offchain text cannot be
            inspected by this relayer.
          </p>
          <Choice
            label="Filter kind"
            value={kind}
            options={[
              ['word', 'Plain word or phrase'],
              ['link', 'Link domain'],
              ...(admin ? [['regex', 'Admin regex'] as [string, string]] : []),
            ]}
            onChange={setKind}
          />
          <Field
            name="pattern"
            label="Word, domain or regex"
            value={pattern}
            onChange={setPattern}
            maxLength={200}
          />
          <Choice
            label="Filter action"
            value={filterAction}
            options={['block', 'hide', 'label'].map((v) => [v, v])}
            onChange={setFilterAction}
          />
          <Button
            disabled={busy || !pattern || !reason}
            onClick={() =>
              run({ action: 'filter', filter: { kind, pattern, action: filterAction, reason } })
            }
          >
            Add filter
          </Button>
          <ul className="space-y-3 text-sm">
            {data?.filters.map((f) => (
              <li key={f.id} className="break-all">
                {f.kind}: {f.pattern} · {f.action} · {f.reason}{' '}
                {(admin || f.kind !== 'regex') && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => run({ action: 'deleteFilter', id: f.id })}
                  >
                    Remove filter {f.id}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'Access & invites' && admin && (
        <div className="space-y-5">
          <Field
            name="allowlistCsv"
            label="Allowlist addresses / Lens usernames / CSV"
            multiline
            value={csv}
            onChange={setCsv}
            hint="One identity per line, or first CSV column. A header is optional. Usernames resolve to the account and its current owner."
          />
          <label className="block text-sm">
            Import CSV file
            <input
              className="mt-2 block max-w-full"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCsv(await file.text());
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !csv} onClick={() => run({ action: 'allowlistImport', csv })}>
              Add to allowlist
            </Button>
            <Button
              disabled={busy || !csv}
              onClick={() => run({ action: 'allowlistImport', csv, remove: true })}
            >
              Remove from allowlist
            </Button>
          </div>
          <details>
            <summary>Allowlist ({data?.allowlist.length ?? 0})</summary>
            <ul className="break-all text-xs">
              {data?.allowlist.map((a) => (
                <li key={a.address}>
                  {a.address} · added by {a.added_by}
                </li>
              ))}
            </ul>
          </details>
          <Field
            name="inviteCount"
            label="Number of invite codes"
            value={count}
            onChange={setCount}
          />
          <Field
            name="inviteUses"
            label="Uses per code (1 for single-use)"
            value={maxUses}
            onChange={setMaxUses}
          />
          <Field
            name="inviteExpiry"
            label="Invite expiry (ISO time, e.g. 2027-01-01T00:00:00Z)"
            value={expiry}
            onChange={setExpiry}
          />
          <Button
            disabled={busy || !expiry}
            onClick={() =>
              run({
                action: 'invites',
                count: Number(count),
                maxUses: Number(maxUses),
                expiresAt: expiry,
              })
            }
          >
            Generate invite codes
          </Button>
          {codes.length > 0 && (
            <div>
              <p className="text-sm">
                Copy these codes now. Only their hashes are stored; they cannot be shown again.
              </p>
              <pre className="overflow-x-auto p-3 text-xs">{codes.join('\n')}</pre>
            </div>
          )}
          <ul className="space-y-4 text-xs">
            {data?.invites.map((i) => (
              <li key={i.id} className="break-all">
                Invite #{i.id} · {i.uses}/{i.max_uses} uses · expires {i.expires_at}
                <p>Created by {i.created_by}</p>
                {i.redeemed.map((r) => (
                  <p key={r.owner}>
                    Redeemed by {r.owner} at {r.at}
                  </p>
                ))}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => run({ action: 'revokeInvite', id: i.id })}
                >
                  Expire invite {i.id}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'Log' && (
        <div className="space-y-4">
          <p className="text-sm">
            Latest 100 moderation audit entries. Enter an account address for its history.
          </p>
          <Field
            name="historyTarget"
            label="Account history / target"
            value={target}
            onChange={setTarget}
          />
          <ol className="divide-y divide-border-default text-xs">
            {data?.log.map((entry) => (
              <li key={entry.id} className="space-y-1 break-all py-3">
                <p>
                  #{entry.id} · {entry.created_at} · {entry.action}
                </p>
                <p>{entry.actor}</p>
                <p>{JSON.stringify(entry.details)}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
