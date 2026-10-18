'use client';

import { EXPLORER_URL } from '@/lib/config';
import { ThemeToggle } from './theme';

const LINKS = [
  { label: 'Lens Protocol', href: 'https://lens.xyz' },
  { label: 'Monad', href: 'https://monad.xyz' },
  { label: 'Docs', href: 'https://docs.monad.xyz' },
  ...(EXPLORER_URL ? [{ label: 'Explorer', href: EXPLORER_URL }] : []),
];

/** What this runs on, the explorer to check it, and the color mode: the aside's footer and the landing page's. */
export function FooterLinks({ className = '' }: { className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary ${className}`}
    >
      {LINKS.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          {link.label}
        </a>
      ))}
      <ThemeToggle />
    </div>
  );
}
