'use client';
import { EmailSettings } from '@/components/email-settings';

import { useMutation } from '@tanstack/react-query';
import { useConnection, useDisconnect } from 'wagmi';
import { atHandle, Avatar, displayName } from '@/components/account';
import { Icon } from '@/components/icons';
import { ConnectWalletButton, SignOutButton } from '@/components/auth';
import { useAuthModal, useEditProfile } from '@/components/modals';
import { useTheme, type Theme } from '@/components/theme';
import { useToast } from '@/components/toast';
import { Button, CornerBrackets, PageHeader } from '@/components/ui';
import { useGasMode, useLensActions, useSponsorship, type GasMode } from '@/lib/actions';
import { useBrand } from '@/lib/runtime-config';
import { useNetwork } from '@/lib/runtime-config';
import { useProfile } from '@/lib/indexer';
import { useSession } from '@/lib/session';
import { usePageTitle } from '@/lib/title';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border-default px-4 py-6" aria-label={title}>
      <h2 className="text-xl leading-7">{title}</h2>
      {description && (
        <p className="mt-1 max-w-[65ch] text-sm text-pretty text-text-secondary">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Segmented control: the active option is an elevated tile, not a color. */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-sm border border-border-default bg-bg-subtle p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          onClick={() => onChange(option.id)}
          className={`focus-ring h-8 rounded-sm px-4 text-sm font-medium transition-colors duration-150 ${option.id === value ? 'bg-bg-elevated text-text-primary shadow-[0_0_0_1px_var(--border-default)]' : 'text-text-secondary hover:text-text-primary'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Selection card, as a radio: brackets on hover, the focus border when selected. */
function SelectionCard({
  selected,
  onSelect,
  title,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`group/card focus-ring relative flex w-full gap-3 rounded-sm border bg-bg-elevated p-4 text-left transition-colors duration-150 ${selected ? 'border-border-focus' : 'border-border-default hover:border-border-hover'}`}
    >
      {!selected && (
        <span className="hidden group-hover/card:contents">
          <CornerBrackets size={8} />
        </span>
      )}
      <span
        aria-hidden
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected ? 'border-accent-primary bg-accent-primary' : 'border-border-strong'}`}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-text-on-accent" />}
      </span>
      <span>
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="mt-1 block text-sm text-text-secondary">{children}</span>
      </span>
    </button>
  );
}

function AccountSection() {
  const { account, signOut } = useSession();
  const { data } = useProfile(account, null);
  const editProfile = useEditProfile();
  const { mutate: disconnect } = useDisconnect();
  if (!data) {
    return null;
  }
  return (
    <Section title="Your account">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar account={data.account} size={48} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="truncate font-semibold text-text-primary">
            {displayName(data.account)}
          </div>
          <div className="truncate text-text-tertiary">{atHandle(data.account)}</div>
        </div>
        <div className="flex gap-2">
          <Button onClick={editProfile}>Edit profile</Button>
          <Button
            variant="ghost"
            onClick={() => signOut.mutate(undefined, { onSuccess: () => disconnect() })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </Section>
  );
}

function FeesSection() {
  const { APP_NAME } = useBrand();
  const { account } = useSession();
  const { data } = useProfile(account, null);
  const [mode, setMode] = useGasMode();
  const available = useSponsorship();
  const { isConnected } = useConnection();
  const { enableSponsorship, sponsorshipAllowed } = useLensActions();
  const toast = useToast();
  const enable = useMutation({
    mutationFn: enableSponsorship,
    onSuccess: () => toast.show(`${APP_NAME} now pays your network fees`),
    onError: (error) => toast.error(error.message),
  });
  const options: { id: GasMode; title: string; description: string }[] = [
    {
      id: 'sponsored',
      title: `${APP_NAME} pays (free)`,
      description:
        available === false
          ? `${APP_NAME} isn't paying network fees right now, so your wallet pays until it does.`
          : `${APP_NAME} sends your posts, follows and profile changes for you and pays their fees. It can act for your account but never move its funds, and you can revoke it anytime.`,
    },
    {
      id: 'direct',
      title: 'My wallet pays',
      description:
        'Your wallet sends each action itself and pays its fee in MON. No app in between.',
    },
  ];
  return (
    <Section
      title="Network fees"
      description="Every post, follow and profile change is a transaction on Monad. Choose who pays its fee."
    >
      <div role="radiogroup" aria-label="Who pays network fees" className="flex flex-col gap-3">
        {options.map((option) => (
          <SelectionCard
            key={option.id}
            selected={mode === option.id}
            onSelect={() => setMode(option.id)}
            title={option.title}
          >
            {option.description}
          </SelectionCard>
        ))}
      </div>
      {(mode === 'direct' || sponsorshipAllowed === false) && !isConnected && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border-default bg-bg-elevated px-4 py-3">
          <p className="text-sm text-text-secondary">
            Connect the wallet that owns this account to pay from it.
          </p>
          <ConnectWalletButton />
        </div>
      )}
      {sponsorshipAllowed === false && (
        <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 bg-status-info-bg py-3 pr-4 pl-4">
          <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-status-info" />
          <p className="text-sm text-text-primary">
            This account doesn&apos;t let {APP_NAME} pay its fees yet, so your wallet pays for
            everything.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
          >
            {enable.isPending ? 'Allowing…' : `Let ${APP_NAME} pay`}
          </Button>
        </div>
      )}
    </Section>
  );
}

/** A copyable value, and its page on the block explorer when there is one. */
function SpecRow({ topic, value, href }: { topic: string; value: string; href?: string | null }) {
  const toast = useToast();
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-default py-2 last:border-b-0">
      <span className="text-sm text-text-primary">{topic}</span>
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          title="Copy"
          onClick={() =>
            navigator.clipboard.writeText(value).then(() => toast.show(`${topic} copied`))
          }
          className="focus-ring flex min-w-0 items-center gap-2 rounded-sm font-mono text-xs text-text-secondary hover:text-text-primary"
        >
          <bdi className="truncate">{value}</bdi>
          <Icon name="link" size={12} className="shrink-0" />
        </button>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title="View on explorer"
            aria-label={`View ${topic} on explorer`}
            className="focus-ring shrink-0 rounded-sm text-text-secondary hover:text-text-primary"
          >
            <Icon name="share" size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { chain, contracts, EXPLORER_URL, explorerAddressUrl } = useNetwork();
  const { APP_NAME } = useBrand();
  const { owner, account } = useSession();
  const [theme, setTheme] = useTheme();
  const openAuth = useAuthModal();
  usePageTitle('Settings');

  return (
    <>
      <PageHeader title="Settings" />
      {account ? (
        <AccountSection />
      ) : (
        <Section title="Your account">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-text-secondary">
              Sign in to edit your profile and choose who pays network fees.
            </p>
            <div className="flex gap-2">
              {owner && <SignOutButton />}
              <Button variant="primary" onClick={openAuth}>
                {owner ? 'Create account' : 'Sign in'}
              </Button>
            </div>
          </div>
        </Section>
      )}
      <Section title="Appearance">
        <SegmentedControl<Theme>
          label="Color mode"
          value={theme}
          onChange={setTheme}
          options={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
            { id: 'system', label: 'System' },
          ]}
        />
      </Section>
      {account && <FeesSection />}
      <EmailSettings />
      <Section
        title="Network"
        description={`${APP_NAME} reads and writes Lens Protocol V3 contracts on ${chain.name}. Any Lens app can read the same data.`}
      >
        <div>
          <SpecRow topic="Network" value={`${chain.name} (${chain.id})`} href={EXPLORER_URL} />
          {owner && <SpecRow topic="Wallet" value={owner} href={explorerAddressUrl(owner)} />}
          {account && (
            <SpecRow topic="Lens account" value={account} href={explorerAddressUrl(account)} />
          )}
          {(
            [
              ['Feed', contracts.LensGlobalFeed],
              ['Graph', contracts.LensGlobalGraph],
              ['Namespace', contracts.LensGlobalNamespace],
              ['SponsorRouter', contracts.SponsorRouter],
            ] as const
          ).map(([topic, address]) => (
            <SpecRow key={topic} topic={topic} value={address} href={explorerAddressUrl(address)} />
          ))}
        </div>
      </Section>
    </>
  );
}
