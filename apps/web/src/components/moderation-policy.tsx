'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ModerationPolicy } from '@/lib/moderation-policy';
import { api } from '@/lib/session';
import { Button } from './ui';
import { Field } from './auth';
import { SecretEditor } from './admin-editor';

export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span>{label}</span>
      <select
        aria-label={label}
        className="block w-full rounded-sm border border-border-default bg-bg-elevated p-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([value, title]) => (
          <option key={value} value={value}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ModerationPolicyEditor({ policy }: { policy: ModerationPolicy }) {
  const [draft, setDraft] = useState(policy);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const set = (key: keyof ModerationPolicy, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const choice = (key: keyof ModerationPolicy, label: string, options: [string, string][]) => (
    <Choice
      label={label}
      value={String(draft[key])}
      options={options}
      onChange={(v) => set(key, v)}
    />
  );
  const number = (key: keyof ModerationPolicy, label: string) => (
    <Field
      name={key}
      label={label}
      value={String(draft[key])}
      onChange={(v) => set(key, Number(v))}
    />
  );
  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        These controls govern entry, this server’s relayer, and this instance’s reads. Lens is
        permissionless: nothing here deletes onchain content or prevents wallet-paid transactions
        through another app. Changes apply across servers within 10 seconds.
      </p>
      <fieldset className="space-y-4">
        <legend className="mb-3 text-xl">Access</legend>
        {choice('signupMode', 'Sign-up mode', [
          ['open', 'Open (default)'],
          ['invite', 'Invite codes'],
          ['allowlist', 'Allowlist'],
          ['token', 'Token gate'],
        ])}
        <p className="text-xs text-text-secondary">
          Open accepts any wallet. Invite codes reserve one use per wallet for retries. Allowlist
          accepts wallet addresses; adding an existing Lens username resolves its account and
          current owner. All modes apply to wallet-paid admission too.
        </p>
        {choice('externalAccounts', 'Accounts created in other Lens apps', [
          ['allow', 'Allow (default)'],
          ['approval', 'Require moderator approval'],
          ['allowlist', 'Allowlist only'],
        ])}
        <p className="text-xs text-text-secondary">
          Checked at sign-in, account selection, session refresh and server writes. Pending users
          can ask an admin to approve their account address. An account suspension refuses sign-in
          and relay here; hiding affects only reads.
        </p>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.turnstileEnabled}
            onChange={(e) => set('turnstileEnabled', e.target.checked)}
          />
          Turnstile bot check on sign-up (off by default for local setup)
        </label>
        <p className="text-xs text-text-secondary">
          Enable before production. The server verifies a single-use signup challenge, hostname and
          action. Configure the site key and encrypted secret before enabling.
        </p>
        <Field
          name="turnstileSiteKey"
          label="Turnstile site key"
          value={draft.turnstileSiteKey}
          onChange={(v) => set('turnstileSiteKey', v)}
        />
        <SecretEditor name="captchaSecret" title="Turnstile secret" />
        <Choice
          label="Token standard"
          value={draft.token.standard}
          options={[
            ['erc20', 'ERC-20'],
            ['erc721', 'ERC-721'],
            ['erc1155', 'ERC-1155'],
          ]}
          onChange={(v) => set('token', { ...draft.token, standard: v })}
        />
        <Field
          name="tokenAddress"
          label="Token contract on this instance’s chain"
          value={draft.token.address}
          onChange={(v) => set('token', { ...draft.token, address: v })}
        />
        <Field
          name="tokenMinimum"
          label="ERC-20 minimum in smallest units (default 1)"
          value={draft.token.minimum}
          onChange={(v) => set('token', { ...draft.token, minimum: v })}
        />
        <Field
          name="tokenId"
          label="ERC-1155 token ID (default 0)"
          value={draft.token.tokenId}
          onChange={(v) => set('token', { ...draft.token, tokenId: v })}
        />
        <p className="text-xs text-text-secondary">
          On Monad deployments this uses the configured Monad RPC. ERC-721 requires any token in the
          collection; ERC-1155 requires any balance of the selected token ID. Checked at sign-up and
          session refresh, also before relay; balances are cached for 30 seconds. This cannot lock
          tokens or stop transfers.
        </p>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="mb-3 text-xl">Sponsorship</legend>
        {choice('sponsorship', 'Who gets sponsored', [
          ['everyone', 'Everyone (default)'],
          ['members', 'Members only'],
          ['approved', 'Approved only'],
          ['nobody', 'Nobody — wallet-paid only'],
        ])}
        <p className="text-xs text-text-secondary">
          Members joined through this instance’s sign-up checks. Members mode includes admitted
          sign-ups. Approved mode requires approval of an account, or of a wallet before sign-up.
          Revoking one account’s sponsorship never takes away wallet-paid access.
        </p>
        {number('cooldownHours', 'New-account cooldown in hours (default 0)')}
        {choice('cooldownAction', 'During cooldown', [
          ['deny', 'No sponsored actions (default)'],
          ['limit', 'Use the new-account rate limit'],
        ])}
        {number('memberRate', 'Member actions per minute (default 30)')}
        {number('newAccountRate', 'New-account actions per minute (default 5)')}
        {number('approvedRate', 'Approved actions per minute (default 60)')}
        <p className="text-xs text-text-secondary">
          Cooldown is based on the account’s creation time; an unknown account is treated as new.
          The new-account limit takes precedence during cooldown. These per-account limits are
          additional to the global sponsorship limits.
        </p>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="mb-3 text-xl">Content and visibility</legend>
        {choice('homeFeed', 'Home feed scope', [
          ['network', 'Whole network (default)'],
          ['members', 'This instance’s members'],
          ['curated', 'Curated accounts'],
        ])}
        <Field
          name="curatedAccounts"
          label="Curated Lens account addresses (one per line)"
          multiline
          value={draft.curatedAccounts.join('\n')}
          onChange={(v) => set('curatedAccounts', v.split(/[\s,]+/).filter(Boolean))}
        />
        <p className="text-xs text-text-secondary">
          Scopes Home and Following and the trend counts shown here. Search and direct profiles
          still let people discover the network. Explicit hide and word/link filters apply to all
          reads, including search, threads, notifications and trends. A hidden thread shows “Hidden
          by moderators”.
        </p>
      </fieldset>
      <Button
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage('');
          try {
            await api('/api/admin/config', { method: 'PUT', body: { moderation: draft } });
            setMessage('Moderation policy saved. Changes apply within 10 seconds.');
            router.refresh();
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save moderation policy
      </Button>
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
