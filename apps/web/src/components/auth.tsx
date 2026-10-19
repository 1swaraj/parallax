'use client';

import { usernameError } from '@lens-monad/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect } from 'wagmi';
import { useGasMode, useLensActions, useSponsorship } from '@/lib/actions';
import { APP_NAME } from '@/lib/brand';
import { MAX_BIO_CHARACTERS, MAX_NAME_CHARACTERS } from '@/lib/config';
import { useProfile } from '@/lib/indexer';
import { NEW_PASSKEY, PASSKEY } from '@/lib/passkey';
import { useSession } from '@/lib/session';
import { atHandle, Avatar, displayName } from './account';
import { Icon, type IconName } from './icons';
import { useToast } from './toast';
import { Button, Dropdown, Spinner } from './ui';

function useDebounced<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Whether the indexer knows an account with that username. Reserved usernames are only checked onchain. */
function useUsernameTaken(username: string) {
  const debounced = useDebounced(username);
  const query = useQuery({
    queryKey: ['username-taken', debounced],
    queryFn: async () => (await fetch(`/indexer/accounts/${debounced}`)).status !== 404,
    enabled: debounced.length > 0 && usernameError(debounced) === null,
  });
  return { taken: query.data, checking: debounced !== username || query.isFetching };
}

/** An input with a visible native label, a hint or an error under it, and an optional counter. */
export function Field({
  label,
  value,
  onChange,
  maxLength,
  multiline,
  prefix,
  error,
  hint,
  autoFocus,
  placeholder,
  name,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  multiline?: boolean;
  prefix?: string;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
  placeholder?: string;
  name: string;
  inputMode?: 'text' | 'url';
}) {
  const id = useId();
  const described = `${id}-description`;
  const Input = multiline ? 'textarea' : 'input';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-text-primary">
          {label}
        </label>
        {maxLength && (
          <span className="font-mono text-xs text-text-tertiary tabular-nums">
            {value.length}/{maxLength}
          </span>
        )}
      </div>
      <div
        className={`flex rounded-sm border bg-bg-elevated px-3 transition-colors duration-150 focus-within:border-border-focus ${error ? 'border-status-error' : 'border-border-default hover:border-border-hover'}`}
      >
        {prefix && <span className="py-2 text-base text-text-tertiary sm:text-sm">{prefix}</span>}
        <Input
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
          autoFocus={autoFocus}
          placeholder={placeholder}
          spellCheck={!prefix && inputMode !== 'url'}
          autoComplete="off"
          inputMode={inputMode}
          aria-invalid={!!error}
          aria-describedby={error || hint ? described : undefined}
          rows={multiline ? 3 : undefined}
          className="w-full resize-none bg-transparent py-2 text-base text-text-primary outline-none placeholder:text-text-tertiary sm:text-sm"
        />
      </div>
      {(error || hint) && (
        <p
          id={described}
          className={`text-xs ${error ? 'text-status-error' : 'text-text-tertiary'}`}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function CreateAccountForm({ onCreated }: { onCreated?: () => void }) {
  const toast = useToast();
  const { signUp } = useLensActions();
  const [gasMode] = useGasMode();
  const available = useSponsorship();
  const free = gasMode === 'sponsored' && available !== false;
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const invalid = username ? usernameError(username) : null;
  const { taken, checking } = useUsernameTaken(username);

  const create = useMutation({
    mutationFn: () => signUp({ username, name, bio }),
    onSuccess: () => {
      toast.show(`Welcome, @${username}`);
      onCreated?.();
    },
    onError: (error) => toast.error(error.message),
  });

  const ready = username && !invalid && !taken && !checking && !create.isPending;
  return (
    <form
      className="flex flex-col gap-6"
      aria-busy={create.isPending}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          create.mutate();
        }
      }}
    >
      <Field
        name="username"
        label="Username"
        prefix="@"
        value={username}
        onChange={(value) => setUsername(value.toLowerCase().replace(/\s/g, ''))}
        maxLength={30}
        autoFocus
        error={invalid ?? (taken ? 'That username is taken. Try another one.' : null)}
        hint="At least 4 characters: lowercase letters, digits, _ and -."
      />
      <Field
        name="name"
        label="Display name (optional)"
        value={name}
        onChange={setName}
        maxLength={MAX_NAME_CHARACTERS}
      />
      <Field
        name="bio"
        label="Bio (optional)"
        value={bio}
        onChange={setBio}
        maxLength={MAX_BIO_CHARACTERS}
        multiline
      />
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-text-tertiary">
          {free
            ? `Free: ${APP_NAME} pays the network fee.`
            : 'Your wallet pays the network fee, in MON.'}
        </p>
        <Button type="submit" variant="primary" disabled={!ready}>
          {create.isPending ? 'Creating…' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}

const STEPS = ['Connect', 'Sign in', 'Create account'];

/** Steps indicator: where the user is in the sign-in flow, and what remains. */
function StepsIndicator({ current }: { current: number }) {
  return (
    <ol className="flex items-start" aria-label="Sign-in steps">
      {STEPS.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'future';
        return (
          <li
            key={step}
            className="flex flex-1 flex-col items-center gap-2"
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <div className="flex w-full items-center">
              <span
                className={`h-px flex-1 ${index === 0 ? 'opacity-0' : index <= current ? 'bg-accent-primary' : 'bg-border-default'}`}
              />
              <span
                className={`grid h-6 w-6 place-items-center rounded-full font-mono text-[9px] font-medium ${
                  state === 'done'
                    ? 'bg-accent-primary text-text-on-accent'
                    : state === 'current'
                      ? 'border border-accent-primary bg-accent-subtle text-accent-primary'
                      : 'border border-border-default text-text-tertiary'
                }`}
              >
                {state === 'done' ? (
                  <Icon name="check" size={12} strokeWidth={2.5} />
                ) : (
                  `0${index + 1}`
                )}
              </span>
              <span
                className={`h-px flex-1 ${index === STEPS.length - 1 ? 'opacity-0' : index < current ? 'bg-accent-primary' : 'bg-border-default'}`}
              />
            </div>
            <span
              className={`text-[11px] ${state === 'current' ? 'text-text-primary' : state === 'done' ? 'text-text-secondary' : 'text-text-tertiary'}`}
            >
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mt-8 mb-6">
      <h2 className="text-2xl leading-8">{title}</h2>
      <p className="mt-2 max-w-[48ch] text-sm text-pretty text-text-secondary">{subtitle}</p>
    </div>
  );
}

/**
 * Tells someone a wallet didn't connect. Without an extension, the browser wallet has nothing to talk to; closing the
 * wallet's prompt (or WalletConnect's QR code) is a choice, not an error.
 */
export function connectErrorToast(toast: ReturnType<typeof useToast>) {
  return (error: Error) => {
    if (error.name === 'UserRejectedRequestError') {
      return;
    }
    toast.error(
      error.name === 'ProviderNotFoundError'
        ? "There's no wallet in this browser: install one, or open the app in your wallet's browser."
        : error.message.split('\n')[0]!
    );
  };
}

/** What a wallet connector is called on screen: wagmi's generic injected connector is the browser's wallet. */
export function connectorName(connector: { name: string }) {
  return connector.name === 'Injected' ? 'Browser wallet' : connector.name;
}

export function connectorIcon(connector: { type: string }): IconName {
  return connector.type === PASSKEY ? 'key' : 'wallet';
}

/**
 * The ways in, passkeys first: creating an account with one is the main action, signing in with one comes next, and
 * wallets are a step away. Without passkeys (NEXT_PUBLIC_PASSKEYS=false, or no WebAuthn), the wallets show at once.
 * `onConnected` runs once a connector connects; the sign-in flow takes over from there.
 */
export function SignInOptions({ onConnected }: { onConnected?: () => void }) {
  const connectors = useConnectors();
  const { mutate: connect, isPending, variables } = useConnect();
  const available = useSponsorship();
  const toast = useToast();
  const [showWallets, setShowWallets] = useState(false);
  const create = connectors.find((connector) => connector.id === NEW_PASSKEY);
  const passkey = connectors.find((connector) => connector.id === PASSKEY);
  const wallets = connectors.filter((connector) => connector.type !== PASSKEY);

  const button = (
    connector: (typeof connectors)[number],
    variant: 'primary' | 'secondary',
    label: string
  ) => (
    <Button
      key={connector.uid}
      variant={variant}
      disabled={isPending}
      onClick={() =>
        connect({ connector }, { onSuccess: onConnected, onError: connectErrorToast(toast) })
      }
    >
      <Icon name={connectorIcon(connector)} size={16} />
      {isPending && variables?.connector === connector ? 'Connecting…' : label}
    </Button>
  );

  return (
    <div className="flex w-full flex-col gap-3">
      {create && passkey ? (
        <>
          {button(create, 'primary', 'Create an account')}
          {button(passkey, 'secondary', 'Sign in with a passkey')}
          <p className="text-xs text-text-tertiary">
            Your passkey is your account: Face ID, Touch ID or your password manager. No wallet, no
            seed phrase.
          </p>
          {wallets.length > 0 &&
            (showWallets ? (
              <div className="mt-2 flex flex-col gap-3 border-t border-border-default pt-5">
                {wallets.map((wallet) =>
                  button(wallet, 'secondary', `Continue with ${connectorName(wallet)}`)
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowWallets(true)}
                className="focus-ring mt-1 self-start rounded-sm text-sm text-text-secondary underline-offset-4 hover:text-text-primary hover:underline"
              >
                Use a wallet instead
              </button>
            ))}
        </>
      ) : (
        wallets.map((wallet, index) =>
          button(
            wallet,
            index === 0 ? 'primary' : 'secondary',
            `Continue with ${connectorName(wallet)}`
          )
        )
      )}
      {available !== false && (
        <p className="mt-2 text-xs text-text-tertiary">
          Joining and posting are free: {APP_NAME} pays the network fees.
        </p>
      )}
    </div>
  );
}

/** Connect a wallet, sign in (SIWE, one free signature), create an account if the wallet has none. */
export function AuthFlow({ onDone }: { onDone: () => void }) {
  const { isConnected, address } = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const { owner, account, needsSignIn, signIn } = useSession();
  const toast = useToast();
  const autoSigned = useRef<string | null>(null);

  // Ask for the signature as soon as the wallet is connected, once per address.
  useEffect(() => {
    if (needsSignIn && address && autoSigned.current !== address && !signIn.isPending) {
      autoSigned.current = address;
      signIn.mutate(undefined, { onError: (error) => toast.error(error.message) });
    }
  }, [needsSignIn, address, signIn, toast]);

  useEffect(() => {
    if (account) {
      onDone();
    }
  }, [account, onDone]);

  const step = !isConnected ? 0 : needsSignIn ? 1 : 2;

  return (
    <div className="px-6 pt-6 pb-8">
      <StepsIndicator current={step} />
      {!isConnected ? (
        <>
          <StepTitle
            title={`Join ${APP_NAME}`}
            subtitle="Your username and followers work in any Lens app."
          />
          <SignInOptions />
        </>
      ) : needsSignIn ? (
        <>
          <StepTitle
            title="Sign in"
            subtitle="Sign a message in your wallet to prove it's yours. It's free: signing sends no transaction."
          />
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => disconnect()}>
              Use another wallet
            </Button>
            <Button
              variant="primary"
              disabled={signIn.isPending}
              onClick={() =>
                signIn.mutate(undefined, { onError: (error) => toast.error(error.message) })
              }
            >
              {signIn.isPending ? 'Check your wallet' : 'Sign message'}
            </Button>
          </div>
        </>
      ) : owner && !account ? (
        <>
          <StepTitle
            title="Create your account"
            subtitle="Pick the username people will find you by. It's yours: it works in any Lens app, and no app can take it away."
          />
          <CreateAccountForm onCreated={onDone} />
        </>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

/** Connects a wallet while signed in, to pay from it: the session stays as it is. */
export function ConnectWalletButton() {
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const toast = useToast();
  return (
    <Dropdown
      align="left"
      // A new passkey can't own the signed-in account.
      items={connectors
        .filter((connector) => connector.id !== NEW_PASSKEY)
        .map((connector) => ({
          label: connectorName(connector),
          icon: connectorIcon(connector),
          onSelect: () => connect({ connector }, { onError: connectErrorToast(toast) }),
        }))}
      trigger={({ toggle, open }) => (
        <Button size="sm" aria-expanded={open} disabled={isPending} onClick={toggle}>
          {isPending ? 'Connecting…' : 'Connect wallet'}
        </Button>
      )}
    />
  );
}

/** Sign out, for a wallet that signed in but has no account yet. */
export function SignOutButton() {
  const { signOut } = useSession();
  const { mutate: disconnect } = useDisconnect();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => signOut.mutate(undefined, { onSuccess: () => disconnect() })}
    >
      Sign out
    </Button>
  );
}

/** The account chip at the bottom of the sidebar, with Sign out. */
export function AccountMenu() {
  const { account, signOut } = useSession();
  const { data } = useProfile(account, null);
  const { mutate: disconnect } = useDisconnect();
  if (!data) {
    return null;
  }
  const me = data.account;
  return (
    <Dropdown
      align="left"
      direction="up"
      items={[
        {
          label: `Sign out ${atHandle(me)}`,
          icon: 'logout',
          onSelect: () => signOut.mutate(undefined, { onSuccess: () => disconnect() }),
        },
      ]}
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label="Account menu"
          className="focus-ring flex w-full items-center gap-3 rounded-sm p-2 text-left transition-colors duration-150 hover:bg-bg-hover"
        >
          <Avatar account={me} size={40} />
          <div className="min-w-0 flex-1 text-sm max-xl:hidden">
            <div className="truncate font-semibold text-text-primary">{displayName(me)}</div>
            <div className="truncate text-text-tertiary">{atHandle(me)}</div>
          </div>
          <Icon name="more" size={18} className="text-text-tertiary max-xl:hidden" />
        </button>
      )}
    />
  );
}
