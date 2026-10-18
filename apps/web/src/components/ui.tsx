'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';

/*
 * Primitives: button, menus, modal, tabs, empty state, and the decorative vocabulary (corner brackets on hovered content, corner squares on the page rails).
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

const BUTTON_BASE =
  'group relative isolate inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-mono font-medium uppercase tracking-normal ' +
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:opacity-0 before:content-[''] " +
  "after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:rounded-[inherit] after:opacity-0 after:content-[''] " +
  'before:transition-opacity after:transition-opacity before:duration-150 after:duration-150 ' +
  'transition-[background-color,box-shadow,color,scale] duration-150 ease-[var(--motion-ease-out)] active:scale-[0.97] ' +
  'outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default ' +
  'disabled:pointer-events-none disabled:cursor-default disabled:opacity-50';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] shadow-[var(--button-primary-shadow)] ' +
    'before:[background-image:var(--button-primary-gradient)] before:opacity-100 ' +
    'after:[background-image:var(--button-primary-gradient-hover)] hover:before:opacity-0 hover:after:opacity-[0.66] ' +
    'hover:shadow-[var(--button-primary-shadow-hover)] active:bg-[var(--button-primary-pressed)]',
  secondary:
    'bg-[var(--button-secondary-bg)] text-text-primary shadow-[var(--button-secondary-shadow)] ' +
    'before:[background-image:var(--button-secondary-gradient)] before:opacity-[var(--button-secondary-gradient-opacity)] ' +
    'after:[background-image:var(--button-secondary-gradient)] hover:before:opacity-0 hover:after:opacity-[var(--button-secondary-gradient-hover-opacity)] ' +
    'active:bg-[var(--button-secondary-bg-pressed)]',
  ghost: 'text-text-primary hover:text-[var(--button-ghost-text-hover)] active:bg-bg-pressed',
  destructive:
    'bg-[var(--button-destructive-bg)] text-[var(--button-destructive-text)] shadow-[var(--button-destructive-shadow)] ' +
    'before:[background-image:var(--button-primary-gradient)] before:opacity-100 ' +
    'after:[background-image:var(--button-destructive-gradient-hover)] hover:before:opacity-0 hover:after:opacity-[0.66] ' +
    'hover:shadow-[var(--button-destructive-shadow-hover)] active:bg-[var(--button-destructive-pressed)]',
};

const BUTTON_SIZES = {
  default: 'h-9 px-4 text-sm leading-5',
  sm: 'h-8 px-3 text-xs leading-4',
  icon: 'h-9 w-9 p-0',
};

/** Button styles for links that navigate (`<Link className={buttonClassName()}>`), so no button nests in a link. */
export function buttonClassName(
  variant: ButtonVariant = 'secondary',
  size: keyof typeof BUTTON_SIZES = 'default'
) {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]}`;
}

/** Button: four variants, mono caps labels, content-fit width. At most one primary per surface. */
export function Button({
  variant = 'secondary',
  size = 'default',
  className = '',
  children,
  ...props
}: React.ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
    >
      {children}
    </button>
  );
}

/** An icon-only control: close, back, menus. Transparent; the icon darkens or turns purple on hover. */
export function IconButton({
  icon,
  label,
  size = 20,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-sm text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary active:bg-bg-pressed disabled:opacity-50 ${className}`}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/** Corner brackets on hovered content surfaces: 8px arms on rows and tiles, 16px on cards. */
export function CornerBrackets({
  size = 8,
  className = '',
}: {
  size?: 8 | 16;
  className?: string;
}) {
  const arm = size === 16 ? 'h-4 w-4' : 'h-2 w-2';
  const base = `pointer-events-none absolute border-text-primary ${arm} ${className}`;
  return (
    <>
      <span aria-hidden className={`${base} top-0 left-0 border-t border-l`} />
      <span aria-hidden className={`${base} top-0 right-0 border-t border-r`} />
      <span aria-hidden className={`${base} bottom-0 left-0 border-b border-l`} />
      <span aria-hidden className={`${base} right-0 bottom-0 border-r border-b`} />
    </>
  );
}

/** Corner squares mark where a hairline meets the page rails (structural, never on interactive surfaces). */
export function RailSquares({ position = 'bottom' }: { position?: 'top' | 'bottom' }) {
  const vertical = position === 'bottom' ? '-bottom-[3.5px]' : '-top-[3.5px]';
  return (
    <>
      <span
        aria-hidden
        className={`pointer-events-none absolute -left-[3.5px] z-10 size-[6px] bg-border-default ${vertical} max-sm:hidden`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute -right-[3.5px] z-10 size-[6px] bg-border-default ${vertical} max-sm:hidden`}
      />
    </>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex justify-center py-8 ${className}`} role="status" aria-label="Loading">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-primary" />
    </div>
  );
}

/** Indeterminate progress, under a header or a composer while something sends. */
export function ProgressBar() {
  return (
    <div
      className="relative h-1 overflow-hidden bg-bg-pressed"
      role="progressbar"
      aria-label="Sending"
    >
      <div className="animate-indeterminate absolute inset-y-0 w-2/5 bg-accent-primary" />
    </div>
  );
}

export function PostSkeleton() {
  return (
    <div className="flex gap-3 border-b border-border-default px-4 py-4" aria-hidden>
      <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-bg-subtle" />
      <div className="flex-1 space-y-3 pt-1">
        <div className="h-3 w-2/5 animate-pulse rounded-sm bg-bg-subtle" />
        <div className="h-3 w-11/12 animate-pulse rounded-sm bg-bg-subtle" />
        <div className="h-3 w-3/5 animate-pulse rounded-sm bg-bg-subtle" />
      </div>
    </div>
  );
}

export function FeedSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <PostSkeleton key={i} />
      ))}
    </div>
  );
}

/** Empty state: boxed icon, title, one line, an optional next action. */
export function EmptyState({
  icon = 'sparkle',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-md bg-bg-hover text-text-secondary">
        <Icon name={icon} size={24} />
      </div>
      <h2 className="max-w-[25ch] text-2xl leading-8">{title}</h2>
      {children && (
        <p className="max-w-[40ch] text-sm text-pretty text-text-tertiary">{children}</p>
      )}
      {action}
    </div>
  );
}

/** Error banner, for a view that failed to load. */
export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const unreachable = /fetch|NetworkError|50\d/.test(error.message);
  return (
    <div className="relative m-4 flex items-center justify-between gap-3 bg-status-error-bg py-3 pr-4 pl-4">
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-status-error" />
      <div className="flex items-center gap-3 text-sm text-text-primary">
        <Icon name="block" size={16} className="text-status-error" />
        {unreachable ? "Couldn't load this. Check your connection and retry." : error.message}
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Tabs: mono caps labels, a 2px focus-colored underline on the active one. Arrow keys move between tabs. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; href?: string; badge?: number }[];
  active: T;
  onChange?: (tab: T) => void;
}) {
  const router = useRouter();
  const select = (tab: (typeof tabs)[number]) =>
    tab.href ? router.push(tab.href) : onChange?.(tab.id);
  return (
    <div role="tablist" className="flex border-b border-border-default">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => select(tab)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowRight'
                ? tabs[(index + 1) % tabs.length]
                : event.key === 'ArrowLeft'
                  ? tabs[(index - 1 + tabs.length) % tabs.length]
                  : null;
            if (next) {
              event.preventDefault();
              select(next);
              const buttons = event.currentTarget.parentElement?.querySelectorAll('button');
              buttons?.[tabs.indexOf(next)]?.focus();
            }
          }}
          className="group focus-ring flex h-12 flex-1 justify-center px-4 transition-colors duration-150 hover:bg-bg-hover"
        >
          <span
            className={`relative flex h-full items-center gap-2 font-mono text-[11px] leading-4 font-medium tracking-[0.8px] uppercase ${tab.id === active ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}`}
          >
            {tab.label}
            {!!tab.badge && (
              <span className="rounded-full bg-accent-primary px-1.5 text-[10px] text-text-on-accent">
                {tab.badge}
              </span>
            )}
            {tab.id === active && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-border-focus" />
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The sticky header of the center column: back, a title, mono metadata. */
export function PageHeader({
  title,
  meta,
  back,
  hideTitle = false,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  back?: boolean;
  hideTitle?: boolean;
  children?: ReactNode;
}) {
  const router = useRouter();
  if (hideTitle) {
    return (
      <div className="sticky top-0 z-20 bg-bg-default">
        <h1 className="sr-only">{title}</h1>
        {children}
      </div>
    );
  }
  return (
    <div className="sticky top-0 z-20 bg-bg-default">
      <div className="relative flex min-h-14 items-center gap-4 border-b border-border-default px-4">
        {back && (
          <IconButton
            icon="back"
            label="Back"
            className="-ml-2"
            onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}
          />
        )}
        <div className="min-w-0 py-2">
          <h1 className="truncate text-xl leading-7">{title}</h1>
          {meta && (
            <p className="mono-caps truncate text-[11px] leading-4 text-text-tertiary">{meta}</p>
          )}
        </div>
        {!children && <RailSquares />}
      </div>
      {children}
    </div>
  );
}

/**
 * Modal: sharp, elevated, with a title row. `bracketed` for technical confirmations. Escape and the scrim close
 * it, focus moves in and comes back, the page behind doesn't scroll.
 */
export function Modal({
  open,
  onClose,
  children,
  title,
  label,
  width = 600,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  label: string;
  width?: number;
  actions?: ReactNode;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      // A layer opened over this one (a confirmation, WalletConnect's QR code) keeps its own keys. It needn't take
      // focus, so look at what's on top.
      const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      if (top && !scrim.current?.contains(top)) {
        return;
      }
      if (event.key === 'Escape') {
        onClose();
      }
      // Keep Tab inside the dialog, pulling focus back in if it got out.
      if (event.key === 'Tab' && panel.current && !panel.current.contains(document.activeElement)) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      if (event.key === 'Tab' && panel.current) {
        const focusable = panel.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    const initial =
      panel.current?.querySelector<HTMLElement>('textarea, input, [data-autofocus]') ??
      panel.current?.querySelector<HTMLElement>(
        'button:not([aria-label="Close"]):not(:disabled), [href]'
      ) ??
      panel.current;
    initial?.focus();
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keydown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') {
    return null;
  }
  return createPortal(
    <div
      ref={scrim}
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay sm:pt-[8vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="animate-float flex h-full w-full flex-col overscroll-contain border-border-default bg-bg-elevated shadow-float sm:h-auto sm:max-h-[84vh] sm:border"
        style={{ maxWidth: width }}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border-default px-3">
          <IconButton icon="close" label="Close" onClick={onClose} />
          <div className="min-w-0 flex-1 truncate text-xl leading-7 font-medium [font-family:var(--font-display)]">
            {title}
          </div>
          {actions}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export type MenuItem = {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
};

/** Dropdown menu: elevated, 4px, Inter rows, destructive items in error red. */
export function Dropdown({
  trigger,
  items,
  align = 'right',
  direction = 'down',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  direction?: 'down' | 'up';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        items[(next + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', keydown);
    };
  }, [open]);
  const visible = items.filter((item) => !item.hidden);
  return (
    <div ref={ref} className="relative" onClick={(event) => event.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && visible.length > 0 && (
        <div
          ref={menu}
          role="menu"
          className={`animate-float absolute z-40 min-w-56 rounded-sm border border-border-default bg-bg-elevated p-1 shadow-float ${direction === 'down' ? 'top-full mt-1' : 'bottom-full mb-2'} ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {visible.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none hover:bg-bg-hover focus-visible:bg-bg-hover ${item.danger ? 'text-status-error' : 'text-text-primary'}`}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Calls `onVisible` when it scrolls into view: infinite scroll. */
export function LoadMore({ onVisible, loading }: { onVisible: () => void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && onVisible(), {
      rootMargin: '600px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible]);
  return <div ref={ref}>{loading && <Spinner />}</div>;
}
