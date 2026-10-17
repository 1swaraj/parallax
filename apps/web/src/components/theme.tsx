'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { Icon } from './icons';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'parallax-theme';

/** Applied before paint (in <head>), so the page never flashes the other mode. Light is the MDS default. */
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=s==='dark'||(s==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

const listeners = new Set<() => void>();

function readTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'dark' || stored === 'system' ? stored : 'light';
}

function apply(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onSystemChange = () => readTheme() === 'system' && apply('system');
      media.addEventListener('change', onSystemChange);
      return () => {
        listeners.delete(listener);
        media.removeEventListener('change', onSystemChange);
      };
    },
    readTheme,
    () => 'light' as const
  );
  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    apply(next);
    listeners.forEach((listener) => listener());
  }, []);
  return [theme, setTheme];
}

/** A compact light/dark switch for the footer strip. Settings has the three-way choice. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="focus-ring flex items-center gap-1 rounded-sm hover:text-text-primary"
    >
      <Icon name="sun" size={14} />
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
