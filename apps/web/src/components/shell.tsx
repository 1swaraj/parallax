'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { APP_NAME, APP_PITCH, APP_TAGLINE } from '@/lib/brand';
import {
  useLastSeenNotification,
  useProfile,
  useRelationships,
  useSuggestedAccounts,
  useTrends,
  useUnreadNotifications,
} from '@/lib/indexer';
import { useLikesSeen, useUnreadLikes } from '@/lib/likes';
import { useSession } from '@/lib/session';
import { AccountRow, Avatar, handleOf } from './account';
import { AccountMenu, SignOutButton } from './auth';
import { FooterLinks } from './footer-links';
import { Landing } from './landing';
import { Logo, Wordmark } from './brand';
import { Icon, type IconName } from './icons';
import { useAuthModal, useCompose } from './modals';
import { Button } from './ui';

type NavItem = { href: string; label: string; icon: IconName; badge?: number };

function useNavItems(): NavItem[] {
  const { account } = useSession();
  const { data: me } = useProfile(account, null);
  const seen = useLastSeenNotification(account);
  const { data: unread } = useUnreadNotifications(account, seen);
  const likesSeen = useLikesSeen(account);
  const { data: unreadLikes } = useUnreadLikes(account, likesSeen);
  return [
    { href: '/', label: 'Home', icon: 'home' },
    { href: '/explore', label: 'Explore', icon: 'search' },
    ...(account
      ? [
          {
            href: '/notifications',
            label: 'Notifications',
            icon: 'bell' as const,
            badge: (unread ?? 0) + (unreadLikes ?? 0),
          },
          ...(me
            ? [{ href: `/u/${handleOf(me.account)}`, label: 'Profile', icon: 'user' as const }]
            : []),
        ]
      : []),
    { href: '/settings', label: 'Settings', icon: 'gear' },
  ];
}

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** The unread count, in the accent: an active state that needs attention. */
function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      className={`rounded-full bg-accent-primary px-1.5 font-mono text-[10px] leading-4 font-medium text-text-on-accent tabular-nums ${className}`}
    >
      {count > 99 ? '99+' : count}
      <span className="sr-only"> unread</span>
    </span>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const items = useNavItems();
  const { account, owner } = useSession();
  const compose = useCompose();
  const openAuth = useAuthModal();
  return (
    <header className="sticky top-0 hidden h-dvh shrink-0 flex-col justify-between py-2 sm:flex sm:w-[72px] xl:w-[248px]">
      <div className="flex flex-col gap-1 max-xl:items-center">
        <Link
          href="/"
          aria-label={`${APP_NAME} home`}
          className="focus-ring mb-2 flex h-12 items-center rounded-sm px-2"
        >
          <span className="xl:hidden">
            <Logo size={28} />
          </span>
          <span className="max-xl:hidden">
            <Wordmark height={18} />
          </span>
        </Link>
        <nav aria-label="Primary" className="flex flex-col gap-1">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                className={`focus-ring relative flex h-11 items-center gap-3 rounded-sm px-3 font-mono text-sm font-medium uppercase transition-colors duration-150 max-xl:w-11 max-xl:justify-center max-xl:px-0 ${
                  active
                    ? 'bg-bg-elevated text-text-primary shadow-[0_0_0_1px_var(--border-default)]'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                }`}
              >
                <Icon name={item.icon} size={22} filled={active} />
                <span className="max-xl:sr-only">{item.label}</span>
                {item.badge !== undefined && (
                  <CountBadge
                    count={item.badge}
                    className="max-xl:absolute max-xl:top-1 max-xl:right-0.5 xl:ml-auto"
                  />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="mt-4 px-1 max-xl:px-0">
          {account ? (
            <>
              <Button variant="primary" className="max-xl:hidden" onClick={() => compose()}>
                <Icon name="feather" size={16} />
                New post
              </Button>
              <Button
                variant="primary"
                size="icon"
                aria-label="New post"
                className="xl:hidden"
                onClick={() => compose()}
              >
                <Icon name="feather" size={18} />
              </Button>
            </>
          ) : (
            <Button variant="primary" className="max-xl:hidden" onClick={openAuth}>
              {owner ? 'Create account' : 'Sign in'}
            </Button>
          )}
        </div>
      </div>
      <div className="max-xl:flex max-xl:justify-center">
        {account ? <AccountMenu /> : owner ? <SignOutButton /> : null}
      </div>
    </header>
  );
}

function MobileHeader() {
  const { account } = useSession();
  const { data: me } = useProfile(account, null);
  const openAuth = useAuthModal();
  return (
    <div className="grid h-14 grid-cols-[1fr_auto_1fr] items-center border-b border-border-default bg-bg-default px-4 sm:hidden">
      <div>
        {me ? (
          <Link
            href={`/u/${handleOf(me.account)}`}
            aria-label="Your profile"
            className="focus-ring inline-block rounded-full"
          >
            <Avatar account={me.account} size={32} />
          </Link>
        ) : null}
      </div>
      <Link href="/" aria-label={`${APP_NAME} home`} className="focus-ring rounded-sm">
        <Logo size={26} />
      </Link>
      <div className="flex justify-end">
        {!me && (
          <Button variant="primary" size="sm" onClick={openAuth}>
            Sign in
          </Button>
        )}
      </div>
    </div>
  );
}

function MobileNav() {
  const pathname = usePathname();
  const items = useNavItems();
  const { account } = useSession();
  const compose = useCompose();
  return (
    <>
      {account && (
        <Button
          variant="primary"
          size="icon"
          aria-label="New post"
          onClick={() => compose()}
          className="fixed right-4 bottom-[calc(72px+env(safe-area-inset-bottom))] z-30 h-12! w-12! sm:hidden"
        >
          <Icon name="feather" size={20} />
        </Button>
      )}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-border-default bg-bg-default pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              className={`focus-ring relative grid h-14 w-14 place-items-center ${active ? 'text-text-primary' : 'text-text-secondary'}`}
            >
              <Icon name={item.icon} size={24} filled={active} />
              {item.badge !== undefined && (
                <CountBadge count={item.badge} className="absolute top-2 right-1.5" />
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

/** Search input. */
export function SearchBox({
  initial = '',
  autoFocus = false,
}: {
  initial?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initial);
  useEffect(() => setQuery(initial), [initial]);
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const value = query.trim();
        router.push(value ? `/explore?q=${encodeURIComponent(value)}` : '/explore');
      }}
    >
      <label className="flex h-10 items-center gap-2 rounded-sm border border-border-default bg-bg-elevated px-3 transition-colors duration-150 focus-within:border-border-focus hover:border-border-hover">
        <Icon
          name="search"
          size={16}
          className={query ? 'text-text-secondary' : 'text-text-tertiary'}
        />
        <span className="sr-only">Search</span>
        <input
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people and posts"
          autoComplete="off"
          autoFocus={autoFocus}
          className="w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-tertiary sm:text-sm"
        />
      </label>
    </form>
  );
}

function WhoToFollow() {
  const { account } = useSession();
  const { data } = useSuggestedAccounts(account, 4);
  const items = data?.items ?? [];
  const { data: relationships } = useRelationships(
    account,
    items.map((item) => item.address)
  );
  if (items.length === 0) {
    return null;
  }
  return (
    <section
      className="border border-border-default bg-bg-elevated"
      aria-labelledby="who-to-follow"
    >
      <h2 id="who-to-follow" className="px-4 pt-4 pb-2 text-xl leading-7">
        Who to follow
      </h2>
      {items.map((item) => (
        <AccountRow
          key={item.address}
          account={item}
          relationship={relationships?.[item.address.toLowerCase()] ?? null}
        />
      ))}
      <Link
        href="/explore"
        className="focus-ring flex items-center gap-1 px-4 py-4 font-mono text-xs font-medium text-text-accent uppercase hover:underline"
      >
        Show more
        <Icon name="back" size={14} className="rotate-180" />
      </Link>
    </section>
  );
}

/** Trending: the hashtags most posted in the last day. */
function Trends() {
  const { data } = useTrends();
  if (!data || data.length === 0) {
    return null;
  }
  return (
    <section className="border border-border-default bg-bg-elevated" aria-labelledby="trends">
      <h2 id="trends" className="px-4 pt-4 pb-2 text-xl leading-7">
        Trending
      </h2>
      {data.map((trend, index) => (
        <Link
          key={trend.tag}
          href={`/explore?q=${encodeURIComponent(`#${trend.tag}`)}&tab=posts`}
          className="focus-ring block px-4 py-3 transition-colors duration-150 hover:bg-bg-hover"
        >
          <span className="mono-caps block text-[11px] leading-4 text-text-tertiary">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="block truncate text-sm font-semibold text-text-primary">
            #{trend.tag}
          </span>
          <span className="block text-xs text-text-tertiary">
            <span className="font-mono tabular-nums">{trend.posts}</span>{' '}
            {trend.posts === 1 ? 'post' : 'posts'}
          </span>
        </Link>
      ))}
    </section>
  );
}

function JoinCard() {
  const openAuth = useAuthModal();
  return (
    <section className="flex flex-col items-start gap-3 border border-border-default bg-bg-elevated p-4">
      <h2 className="text-xl leading-7">New to {APP_NAME}</h2>
      <Button onClick={openAuth}>Create account</Button>
      <p className="text-sm text-text-secondary">
        Pick a username and start posting. Your followers come with you to any Lens app. It&apos;s
        free.
      </p>
    </section>
  );
}

function Aside() {
  const pathname = usePathname();
  const { account } = useSession();
  return (
    <aside className="sticky top-0 hidden h-dvh w-[340px] shrink-0 flex-col gap-4 overflow-y-auto py-2 lg:flex">
      {account && pathname !== '/explore' && <SearchBox />}
      {!account && <JoinCard />}
      {account && <Trends />}
      {account && pathname !== '/explore' && <WhoToFollow />}
      <footer className="px-1 pb-6">
        <FooterLinks />
      </footer>
    </aside>
  );
}

/** X's logged-out bar: the one primary action for visitors. */
function JoinBar() {
  const { owner, account, isLoading } = useSession();
  const { isConnected } = useConnection();
  const openAuth = useAuthModal();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || isLoading || account || isConnected || owner) {
    return null;
  }
  return (
    <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 border-t border-border-default bg-bg-elevated sm:bottom-0">
      <div className="mx-auto flex max-w-[960px] items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <p className="font-display text-lg leading-7 font-medium">{APP_TAGLINE}</p>
          <p className="hidden text-sm text-text-secondary sm:block">{APP_PITCH}</p>
        </div>
        <Button variant="primary" onClick={openAuth}>
          Join {APP_NAME}
        </Button>
      </div>
    </div>
  );
}

/** Moves focus to the main region on route changes, so keyboard and screen reader users land on the page. */
function useRouteFocus(main: React.RefObject<HTMLElement | null>) {
  const pathname = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // A page that focused a field itself (Explore's search box) keeps it.
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      main.current?.focus({ preventScroll: true });
    }
  }, [pathname, main]);
}

/** X's shortcut: "n" opens the composer, anywhere but in a text field. */
function useComposeShortcut() {
  const { account } = useSession();
  const compose = useCompose();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (
        event.key === 'n' &&
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        account
      ) {
        event.preventDefault();
        compose();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [account, compose]);
}

/** Pages signed-out visitors can open: a post, shared by its link. Everything else shows them the landing page. */
function isPublicPath(pathname: string) {
  return pathname.startsWith('/p/');
}

export function Shell({ children }: { children: React.ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const { account, isLoading } = useSession();
  // The session is read in the browser: the server, and the first render that hydrates it, can't know it yet.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useRouteFocus(main);
  useComposeShortcut();
  if (!account && !isPublicPath(pathname)) {
    return !mounted || isLoading ? (
      <div className="grid min-h-dvh place-items-center" role="status" aria-label="Loading">
        <Logo size={48} />
      </div>
    ) : (
      <Landing />
    );
  }
  return (
    <>
      <a
        href="#main"
        className="focus-ring sr-only z-50 rounded-sm bg-bg-elevated px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <div className="dot-grid mx-auto flex min-h-dvh max-w-[1264px] justify-center gap-6 sm:px-4">
        <Sidebar />
        <main
          id="main"
          ref={main}
          tabIndex={-1}
          className="min-h-dvh w-full max-w-[600px] min-w-0 bg-bg-default pb-36 outline-none sm:border-x sm:border-border-default sm:pb-24 lg:pb-0"
        >
          <MobileHeader />
          {children}
        </main>
        <Aside />
      </div>
      <MobileNav />
      <JoinBar />
    </>
  );
}
