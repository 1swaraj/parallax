'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CONFIG_GROUPS } from '@/lib/admin-fields';
import type { InstanceConfig } from '@/lib/instance-schema';
import { CHAIN_ID } from '@/lib/config';
import { api } from '@/lib/session';
import { Button } from './ui';
import { Field } from './auth';

export function AdminEditor({
  group,
  config,
  overrides,
}: {
  group: string;
  config: InstanceConfig;
  overrides: string[];
}) {
  const section = CONFIG_GROUPS[group]!;
  const [draft, setDraft] = useState(config);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const set = (key: keyof InstanceConfig, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const action = async (check = false) => {
    setBusy(true);
    setMessage('');
    try {
      const body = Object.fromEntries(
        section.fields
          .filter((field) => !overrides.includes(field.key))
          .map((field) => [field.key, draft[field.key]])
      );
      if (check) {
        const result = await api<{ ok: boolean; message: string }>('/api/admin/network', {
          method: 'POST',
          body: {
            publicRpcUrl: draft.publicRpcUrl,
            serverRpcUrl: draft.serverRpcUrl,
            indexerUrl: draft.indexerUrl,
          },
        });
        setMessage(result.message);
      } else {
        await api('/api/admin/config', { method: 'PUT', body });
        await queryClient.invalidateQueries({ queryKey: ['instance-config'] });
        setMessage('Saved. Changes apply within 10 seconds.');
        router.refresh();
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      {group === 'network' && (
        <p className="text-sm text-text-secondary">
          Chain {CHAIN_ID}. Chain ID is selected at build time because it selects contracts,
          sessions and shared state.
        </p>
      )}
      {section.fields.map((field) => (
        <div key={field.key} className={overrides.includes(field.key) ? 'opacity-70' : ''}>
          {field.kind === 'boolean' ? (
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-accent-primary"
                checked={!!draft[field.key]}
                disabled={overrides.includes(field.key)}
                onChange={(e) => set(field.key, e.target.checked)}
              />
              <span>
                {field.label}
                {field.help && <span className="mt-1 block text-text-secondary">{field.help}</span>}
              </span>
            </label>
          ) : field.kind === 'theme' ? (
            <label className="text-sm">
              {field.label}
              <select
                aria-label={field.label}
                disabled={overrides.includes(field.key)}
                className="ml-3 bg-bg-subtle p-2"
                value={draft.defaultTheme}
                onChange={(e) => set(field.key, e.target.value)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </label>
          ) : (
            <fieldset disabled={overrides.includes(field.key)}>
              <Field
                name={field.key}
                label={field.label}
                hint={field.help}
                value={String(draft[field.key] ?? '')}
                onChange={(value) =>
                  set(
                    field.key,
                    field.kind === 'number'
                      ? Number(value)
                      : field.key === 'sponsorGasBudgetPerHour' && value === ''
                        ? null
                        : value
                  )
                }
              />
            </fieldset>
          )}
          {overrides.includes(field.key) && (
            <p className="mt-1 text-xs text-text-secondary">
              Overridden by an environment variable. Remove the override to edit here.
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => action()}>
          Save {section.title.toLowerCase()}
        </Button>
        {group === 'network' && (
          <Button disabled={busy} onClick={() => action(true)}>
            Check network
          </Button>
        )}
      </div>
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}

export function SecretEditor({
  name,
  title,
  generate = false,
}: {
  name: 'resendApiKey' | 'relayerPrivateKeys' | 'walletConnectProjectId' | 'captchaSecret';
  title: string;
  generate?: boolean;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{
    address: string;
    funding: string;
    command: string;
    overridden: boolean;
  } | null>(null);
  const run = async (generated: boolean) => {
    setBusy(true);
    try {
      const response = await api<{
        address: string;
        funding: string;
        command: string;
        overridden: boolean;
      }>('/api/admin/secrets', {
        method: 'POST',
        body: { name, ...(generated ? { generate: true } : { value }) },
      });
      setValue('');
      setResult(response.address ? response : null);
      setMessage('Secret saved.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 border-t border-border-default pt-5">
      <label className="block text-sm">
        {title}
        <input
          aria-label={title}
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-2 block w-full rounded-sm border border-border-default bg-bg-subtle p-3"
        />
      </label>
      <p className="text-xs text-text-secondary">
        Write only. The saved value is never returned. Environment variables take precedence.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !value.trim()} onClick={() => run(false)}>
          Save secret
        </Button>
        {generate && (
          <Button disabled={busy} onClick={() => run(true)}>
            Generate relayer key
          </Button>
        )}
      </div>
      {result && (
        <div className="space-y-2 break-words text-sm">
          <p className="font-mono">{result.address}</p>
          <p>{result.funding}</p>
          <p>The router owner must run:</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-subtle p-3 text-xs">
            {result.command}
          </pre>
          {result.overridden && (
            <p>An environment override is active. Remove it before this key can be used.</p>
          )}
        </div>
      )}
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
export function EmailTools() {
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: 'test' | 'domain') => {
    setBusy(true);
    try {
      const result = await api('/api/admin/email', {
        method: 'POST',
        body: { action, ...(action === 'test' ? { to } : {}) },
      });
      setMessage(action === 'test' ? 'Test email sent.' : JSON.stringify(result, null, 2));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 border-t border-border-default pt-5">
      <Field name="test-email" label="Test email recipient" value={to} onChange={setTo} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !to} onClick={() => run('test')}>
          Send test email
        </Button>
        <Button disabled={busy} onClick={() => run('domain')}>
          Check domain
        </Button>
      </div>
      <pre role="status" className="overflow-x-auto whitespace-pre-wrap text-xs">
        {message}
      </pre>
    </div>
  );
}
