'use client';

import type { AccountView, Relationship } from '@lens-monad/protocol';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FollowButton } from './follow-button';
import { CornerBrackets } from './ui';

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function handleOf(account: Pick<AccountView, 'username' | 'address'>) {
  return account.username ?? account.address;
}

export function atHandle(account: Pick<AccountView, 'username' | 'address'>) {
  return account.username ? `@${account.username}` : shortAddress(account.address);
}

export function displayName(account: Pick<AccountView, 'name' | 'username' | 'address'>) {
  return account.name || account.username || shortAddress(account.address);
}

export function profileHref(account: Pick<AccountView, 'username' | 'address'>) {
  return `/u/${handleOf(account)}`;
}

/** Initials for accounts without a picture. */
function initialsOf(account: Pick<AccountView, 'name' | 'username' | 'address'>) {
  const source = account.name || account.username || account.address.slice(2);
  const words = source.trim().split(/\s+/);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2)).toUpperCase();
}

const INITIAL_SIZES: Record<number, string> = {
  20: 'text-[9px]',
  32: 'text-xs',
  40: 'text-sm',
  48: 'text-sm',
  64: 'text-lg',
  96: 'text-2xl',
  120: 'text-3xl',
};

/** Avatar: round, hairline border, the accent border on hover; initials when there is no picture. */
export function Avatar({
  account,
  size = 40,
  hover = false,
}: {
  account: Pick<AccountView, 'address' | 'picture'> &
    Partial<Pick<AccountView, 'name' | 'username'>>;
  size?: number;
  hover?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const picture = account.picture?.startsWith('https://') && !failed ? account.picture : null;
  const frame = `shrink-0 overflow-hidden rounded-full border border-border-default transition-colors duration-150 ${hover ? 'group-hover/avatar:border-accent-primary' : ''}`;
  return picture ? (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-hosted pictures
    <img
      src={picture}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={`${frame} object-cover`}
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      aria-hidden
      className={`${frame} grid place-items-center bg-bg-subtle font-normal text-accent-primary ${INITIAL_SIZES[size] ?? 'text-sm'}`}
      style={{ width: size, height: size }}
    >
      {initialsOf({ name: null, username: null, ...account })}
    </div>
  );
}

/** Name and @handle on one line, the name truncating first. */
export function NameLine({
  account,
  link = true,
  className = '',
}: {
  account: AccountView;
  link?: boolean;
  className?: string;
}) {
  const content = (
    <>
      <span className="truncate font-semibold text-text-primary group-hover/name:underline">
        {displayName(account)}
      </span>
      <span className="ml-1 shrink-0 truncate text-text-tertiary">{atHandle(account)}</span>
    </>
  );
  return link ? (
    <Link
      href={profileHref(account)}
      onClick={(event) => event.stopPropagation()}
      className={`group/name focus-ring flex min-w-0 items-baseline ${className}`}
    >
      {content}
    </Link>
  ) : (
    <span className={`flex min-w-0 items-baseline ${className}`}>{content}</span>
  );
}

/** A small gray badge. */
export function FollowsYou() {
  return (
    <span className="ml-2 shrink-0 rounded-sm bg-bg-subtle px-2 py-0.5 font-mono text-[9px] leading-[11px] font-medium tracking-[1.5px] text-text-secondary uppercase">
      Follows you
    </span>
  );
}

/** Account row: who to follow, followers, search results. Brackets on hover. */
export function AccountRow({
  account,
  relationship,
  showBio = false,
}: {
  account: AccountView;
  relationship?: Relationship | null;
  showBio?: boolean;
}) {
  // A stretched link under the content, with the follow button raised above it: the whole row
  // opens the profile without nesting a button inside a link.
  return (
    <div className="group/avatar relative flex gap-3 px-4 py-3 transition-colors duration-150 hover:bg-bg-hover">
      <Link
        href={profileHref(account)}
        aria-label={`${displayName(account)} ${atHandle(account)}`}
        className="focus-ring absolute inset-0"
      />
      <span className="hidden group-hover/avatar:contents">
        <CornerBrackets size={8} />
      </span>
      <Avatar account={account} size={40} hover />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text-primary">
              {displayName(account)}
            </div>
            <div className="flex items-center text-sm text-text-tertiary">
              <span className="truncate">{atHandle(account)}</span>
              {relationship?.followedBy && <FollowsYou />}
            </div>
          </div>
          <div className="relative z-10">
            <FollowButton target={account} relationship={relationship} />
          </div>
        </div>
        {showBio && account.bio && (
          <p className="mt-1 line-clamp-2 text-sm break-words text-text-secondary">{account.bio}</p>
        )}
      </div>
    </div>
  );
}

const MONTH_DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function useNow() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Compact time: 12s, 5m, 3h, Oct 18, Oct 18, 2025. Rendered after mount, in the reader's time zone. */
export function RelativeTime({ seconds }: { seconds: string }) {
  const date = new Date(Number(seconds) * 1000);
  const now = useNow();
  let label = '';
  if (now !== null) {
    const elapsed = Math.max(0, (now - date.getTime()) / 1000);
    if (elapsed < 60) {
      label = `${Math.max(1, Math.floor(elapsed))}s`;
    } else if (elapsed < 3600) {
      label = `${Math.floor(elapsed / 60)}m`;
    } else if (elapsed < 86400) {
      label = `${Math.floor(elapsed / 3600)}h`;
    } else {
      const sameYear = date.getFullYear() === new Date(now).getFullYear();
      label = (sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(date);
    }
  }
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className="shrink-0 whitespace-nowrap text-text-tertiary tabular-nums hover:underline"
    >
      {label}
    </time>
  );
}

/** 3:24 PM · Oct 18, 2026, as mono metadata. */
export function FullTime({ seconds }: { seconds: string }) {
  const date = new Date(Number(seconds) * 1000);
  const mounted = useNow() !== null;
  return (
    <time dateTime={date.toISOString()} className="mono-caps text-xs text-text-tertiary">
      {mounted
        ? `${date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })} · ${MONTH_DAY_YEAR.format(date)}`
        : ''}
    </time>
  );
}

export function joinedLabel(seconds: string) {
  const date = new Date(Number(seconds) * 1000);
  return `Joined ${date.toLocaleDateString('en', { month: 'long', year: 'numeric' })}`;
}

const TOKEN =
  /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(@[a-z0-9][a-z0-9_-]{2,})|(#[\p{L}\d_]+)/gu;

const LINK =
  'text-text-accent underline decoration-text-accent/30 underline-offset-2 hover:decoration-text-accent';

/** Plain text with links, @mentions and #hashtags. Never renders HTML from the post. */
export function RichText({ text, className = '' }: { text: string; className?: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const stop = (event: React.MouseEvent) => event.stopPropagation();
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    parts.push(text.slice(last, index));
    const [token, url, mention, hashtag] = match;
    if (url) {
      const label = url.replace(/^https?:\/\/(www\.)?/, '');
      parts.push(
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className={LINK}
          onClick={stop}
        >
          {label.length > 32 ? `${label.slice(0, 30)}…` : label}
        </a>
      );
    } else if (mention) {
      parts.push(
        <Link key={index} href={`/u/${mention.slice(1)}`} className={LINK} onClick={stop}>
          {token}
        </Link>
      );
    } else if (hashtag) {
      parts.push(
        <Link
          key={index}
          href={`/explore?q=${encodeURIComponent(hashtag)}&tab=posts`}
          className={LINK}
          onClick={stop}
        >
          {token}
        </Link>
      );
    }
    last = index + token.length;
  }
  parts.push(text.slice(last));
  return (
    <p className={`break-words whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}>
      {parts}
    </p>
  );
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}
