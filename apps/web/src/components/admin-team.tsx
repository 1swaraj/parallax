'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/session';
import { Button } from './ui';
import { Field } from './auth';
import type { Admin } from '@/lib/server/admin';
export function AdminPreferences({ admin }: { admin: Admin }) {
  const [email, setEmail] = useState(admin.email ?? '');
  const [alerts, setAlerts] = useState(admin.alerts);
  const [message, setMessage] = useState('');
  return (
    <div className="space-y-3 border-t border-border-default pt-5">
      <h2 className="text-xl">Your operator alerts</h2>
      <Field name="operator-email" label="Your admin email" value={email} onChange={setEmail} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} />
        Email me relayer, health, budget and report alerts
      </label>
      <Button
        onClick={async () => {
          try {
            await api('/api/admin/preferences', { method: 'PUT', body: { email, alerts } });
            setMessage('Alert preferences saved.');
          } catch (e) {
            setMessage((e as Error).message);
          }
        }}
      >
        Save alert preferences
      </Button>
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
export function AdminTeam({ members }: { members: Admin[] }) {
  const [address, setAddress] = useState('');
  const [role, setRole] = useState('admin');
  const [message, setMessage] = useState('');
  const router = useRouter();
  const run = async (method: string, member: string) => {
    try {
      await api('/api/admin/team', { method, body: { address: member, role } });
      setMessage('Team updated.');
      setAddress('');
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-text-secondary">
        The owner manages the team. Admins manage config and email; moderators can access overview
        and moderation. Only the CLI can reset the owner.
      </p>
      <ul className="divide-y divide-border-default">
        {members.map((member) => (
          <li
            key={member.address}
            className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
          >
            <span className="min-w-0 break-all font-mono text-xs">
              {member.address}
              <span className="block text-text-secondary">{member.role}</span>
            </span>
            {member.role !== 'owner' && (
              <Button size="sm" onClick={() => run('DELETE', member.address)}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Field
        name="team-address"
        label="Wallet address or Lens username"
        value={address}
        onChange={setAddress}
      />
      <label className="text-sm">
        Role
        <select
          aria-label="Role"
          className="ml-3 bg-bg-subtle p-2"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="admin">Admin</option>
          <option value="moderator">Moderator</option>
        </select>
      </label>
      <div>
        <Button disabled={!address} onClick={() => run('PUT', address)}>
          Add or update member
        </Button>
      </div>
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
