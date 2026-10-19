'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useInstanceConfig } from '@/lib/runtime-config';
import { api, useSession } from '@/lib/session';
import { Field } from './auth';
import { Button } from './ui';
export function EmailSettings() {
  const config = useInstanceConfig();
  const { owner } = useSession();
  const [email, setEmail] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['email', owner],
    queryFn: () =>
      api<{ email: string; frequency: string; verified: boolean } | null>('/api/email'),
    enabled: config.emailEnabled && !!owner,
  });
  if (!config.emailEnabled || !owner) return null;
  const run = async (method: 'PUT' | 'DELETE') => {
    setBusy(true);
    try {
      await api('/api/email', { method, body: { email, frequency } });
      setMessage(
        method === 'PUT'
          ? 'Check your inbox to confirm your email. The link expires in 24 hours.'
          : 'Email notifications removed.'
      );
      await query.refetch();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 border-b border-border-default p-4">
      <h2 className="text-xl">Email notifications</h2>
      <p className="text-sm text-text-secondary">
        Optional digests. Confirm your email before any notifications are sent.
      </p>
      {query.data && (
        <p className="text-sm">
          {query.data.email} — {query.data.verified ? 'verified' : 'awaiting confirmation'} (
          {query.data.frequency})
        </p>
      )}
      <Field name="notification-email" label="Email address" value={email} onChange={setEmail} />
      <label className="block text-sm">
        Digest frequency
        <select
          aria-label="Digest frequency"
          className="ml-3 bg-bg-subtle p-2"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly')}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !email} onClick={() => run('PUT')}>
          Send confirmation
        </Button>
        {query.data && (
          <Button disabled={busy} onClick={() => run('DELETE')}>
            Remove email
          </Button>
        )}
      </div>
      <p role="status" className="text-sm">
        {message}
      </p>
    </section>
  );
}
