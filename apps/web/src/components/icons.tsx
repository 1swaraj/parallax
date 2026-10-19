/** Outline icons on a 24px grid. `filled` fills closed shapes, for active navigation items. */

const PATHS = {
  home: 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5.5v-6.5h-5V21H4a1 1 0 0 1-1-1Z',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM21 21l-5.2-5.2',
  bell: 'M6 8.5a6 6 0 1 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5ZM10 20.5a2.3 2.3 0 0 0 4 0',
  user: 'M12 12.5a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5ZM3.5 21a8.5 8.5 0 0 1 17 0Z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  feather:
    'M20.2 3.8a5.6 5.6 0 0 0-7.9 0L5 11.1V19h7.9l7.3-7.3a5.6 5.6 0 0 0 0-7.9ZM16 8 2 22M17.5 15H9',
  reply:
    'M20.5 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.8-.8L3 20.5l1.6-4.6a8.4 8.4 0 0 1-.9-3.9A8.5 8.5 0 0 1 12 3.5h.5a8.5 8.5 0 0 1 8 8Z',
  repost:
    'M17 2.5 20.5 6 17 9.5M3.5 11V9.5a3.5 3.5 0 0 1 3.5-3.5h13.5M7 21.5 3.5 18 7 14.5M20.5 13v1.5a3.5 3.5 0 0 1-3.5 3.5H3.5',
  share:
    'M12 3v12.5M7.5 7.5 12 3l4.5 4.5M4 14.5v4A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M20 12H4.5M11 19l-7-7 7-7',
  calendar:
    'M8 2.5v3M16 2.5v3M3.5 9.5h17M5.5 4h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  close: 'M18 6 6 18M6 6l12 12',
  trash: 'M3.5 6h17M9 6V4h6v2M5.5 6l1 14.5h11l1-14.5M10 10.5v6M14 10.5v6',
  link: 'M10 13.5a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 10.5a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  follow:
    'M16 21v-1.5a4.5 4.5 0 0 0-4.5-4.5H6A4.5 4.5 0 0 0 1.5 19.5V21M8.75 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM19.5 8v6M22.5 11h-6',
  unfollow:
    'M16 21v-1.5a4.5 4.5 0 0 0-4.5-4.5H6A4.5 4.5 0 0 0 1.5 19.5V21M8.75 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22.5 11h-6',
  quote: 'M4 17.5h3.5l2-4v-7h-6v7h3zM13.5 17.5H17l2-4v-7h-6v7h3z',
  check: 'M20 6 9 17l-5-5',
  key: 'M7.5 21a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.7 13.3 20.5 3.5M16.5 7.5 19 10M19 5l2.5 2.5',
  wallet:
    'M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V9a2 2 0 0 0-2-2H5.5M16.5 13.5h.01',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  gas: 'M3.5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M2.5 21h13M14.5 10h2a2 2 0 0 1 2 2v4.5a1.5 1.5 0 0 0 3 0V8.5L18 5M6.5 9.5h5',
  heart:
    'M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.9 3.7 4.5 7.1 4.5c2 0 3.6 1.1 4.9 2.9 1.3-1.8 2.9-2.9 4.9-2.9 3.4 0 5.5 3.4 4.3 6.7-1.7 4.7-9.2 9.3-9.2 9.3Z',
  image:
    'M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5ZM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM20.5 15l-5-5L5 20.5',
  sparkle: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9Z',
} as const;

export type IconName = keyof typeof PATHS;

const FILLABLE: IconName[] = ['home', 'bell', 'user', 'heart'];

export function Icon({
  name,
  size = 20,
  filled = false,
  strokeWidth = 1.5,
  className = '',
}: {
  name: IconName;
  size?: number;
  filled?: boolean;
  strokeWidth?: number;
  className?: string;
}) {
  const fill = filled && FILLABLE.includes(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : filled ? strokeWidth + 0.5 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Parallax's mark: two offset lens elements whose overlap forms a lens. A rounded square, like Monad's. */
