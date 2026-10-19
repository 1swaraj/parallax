'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConnectWalletButton, Field } from './auth';
import { Button } from './ui';
import { AdminEditor, SecretEditor, EmailTools } from './admin-editor';
import { api, useSession } from '@/lib/session';
import type { InstanceConfig } from '@/lib/instance-schema';
const STEPS = ['Claim owner', 'Branding', 'Network', 'Sponsorship', 'Email', 'Moderation', 'Done'];
export function SetupWizard({
  config,
  overrides,
  claimed,
}: {
  config: InstanceConfig;
  overrides: string[];
  claimed: boolean;
}) {
  const [step, setStep] = useState(claimed ? 1 : 0);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const { owner, signIn } = useSession();
  const router = useRouter();
  const claim = async () => {
    setBusy(true);
    try {
      await api('/api/setup', { method: 'POST', body: { token } });
      setToken('');
      setStep(1);
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-5 sm:p-8">
      <h1 className="text-3xl">Set up your instance</h1>
      <p className="text-sm text-text-secondary">
        Your community, your settings. Save each step before continuing. Email and sponsorship are
        optional.
      </p>
      <ol aria-label="Setup progress" className="flex flex-wrap gap-3 font-mono text-xs">
        {STEPS.map((name, i) => (
          <li
            key={name}
            aria-current={i === step ? 'step' : undefined}
            className={i === step ? 'text-accent-primary' : 'text-text-tertiary'}
          >
            {i + 1}. {name}
          </li>
        ))}
      </ol>
      <h2 className="text-2xl">{STEPS[step]}</h2>
      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm">
            Enter the setup token from your environment or server logs, then connect and sign in
            with the wallet that will own this instance. Signing in sends no transaction.
          </p>
          <Field name="setup-token" label="Setup token" value={token} onChange={setToken} />
          {!owner && (
            <div className="flex flex-wrap gap-2">
              <ConnectWalletButton />
              <Button disabled={signIn.isPending} onClick={() => signIn.mutate()}>
                Sign in with wallet
              </Button>
            </div>
          )}
          {signIn.error && <p role="alert">{signIn.error.message}</p>}
          {owner && (
            <>
              <p className="break-all font-mono text-xs">Owner wallet: {owner}</p>
              <Button variant="primary" disabled={busy || !token} onClick={claim}>
                Claim instance
              </Button>
            </>
          )}
        </div>
      )}
      {step === 1 && <AdminEditor group="branding" config={config} overrides={overrides} />}
      {step === 2 && (
        <>
          <AdminEditor group="network" config={config} overrides={overrides} />
          <SecretEditor name="walletConnectProjectId" title="WalletConnect project ID" />
        </>
      )}
      {step === 3 && (
        <>
          <p className="text-sm text-text-secondary">
            Turn the pause switch on to leave sponsorship off. To sponsor actions, set an hourly gas
            budget and fund and allowlist your relayer.
          </p>
          <AdminEditor group="sponsorship" config={config} overrides={overrides} />
          <SecretEditor
            name="relayerPrivateKeys"
            title="Relayer private keys (comma-separated)"
            generate
          />
        </>
      )}
      {step === 4 && (
        <>
          <AdminEditor group="email" config={config} overrides={overrides} />
          <SecretEditor name="resendApiKey" title="Resend API key" />
          <EmailTools />
        </>
      )}
      {step === 5 && (
        <div className="space-y-4 text-sm">
          <p>
            Moderation controls will be available in the admin panel. Instances can hide content
            from their own reads and refuse sponsorship. They cannot delete anything onchain: Lens
            content is permissionless.
          </p>
          <Link className="text-accent-primary underline" href="/admin/moderation">
            View moderation
          </Link>
        </div>
      )}
      {step === 6 && (
        <div className="space-y-4">
          <p>Your instance is ready. You can change these settings later in the admin panel.</p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/api/setup', { method: 'PUT', body: {} });
                window.location.href = '/admin';
              } catch (e) {
                setMessage((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Finish setup
          </Button>
        </div>
      )}
      <p role="status" className="text-sm">
        {message}
      </p>
      {step > 0 && (
        <div className="flex justify-between border-t border-border-default pt-5">
          <Button disabled={step <= 1} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          {step < 6 && (
            <Button
              onClick={() => {
                setStep(step + 1);
                setMessage('');
              }}
            >
              Continue
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
