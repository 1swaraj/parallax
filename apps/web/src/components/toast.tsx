'use client';

import Link from 'next/link';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

type Action = { label: string; href: string };
type Toast = { id: number; message: string; error: boolean; action?: Action };
type Toaster = {
  show: (message: string, action?: Action) => void;
  error: (message: string) => void;
};

const ToastContext = createContext<Toaster>({ show: () => {}, error: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const READ_TIME = 5000;

/**
 * MDS Toast: elevated, a status strip, mono caps action. Routine toasts leave after a readable interval (paused on
 * hover); errors and toasts with an action stay until dismissed. Announced through a live region, never focused.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const schedule = useCallback(
    (toast: Toast) => {
      if (!toast.error && !toast.action) {
        timers.current.set(
          toast.id,
          setTimeout(() => dismiss(toast.id), READ_TIME)
        );
      }
    },
    [dismiss]
  );

  const push = useCallback(
    (message: string, error: boolean, action?: Action) => {
      const toast = { id: Date.now() + Math.random(), message, error, action };
      setToasts((current) => [...current.slice(-2), toast]);
      schedule(toast);
    },
    [schedule]
  );

  const toaster = useMemo<Toaster>(
    () => ({
      show: (message, action) => push(message, false, action),
      error: (message) => push(message, true),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={toaster}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:right-6 sm:bottom-6 sm:left-auto sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.error ? 'alert' : 'status'}
            onMouseEnter={() => clearTimeout(timers.current.get(toast.id))}
            onMouseLeave={() => schedule(toast)}
            className="animate-float pointer-events-auto relative flex w-full max-w-[400px] items-center gap-3 overflow-hidden rounded-sm border border-border-default bg-bg-elevated py-3 pr-2 pl-4 shadow-float"
          >
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 w-0.5 ${toast.error ? 'bg-status-error' : 'bg-status-success'}`}
            />
            <Icon
              name={toast.error ? 'block' : 'check'}
              size={16}
              className={toast.error ? 'text-status-error' : 'text-status-success'}
            />
            <span className="flex-1 text-sm text-text-primary">{toast.message}</span>
            {toast.action && (
              <Link
                href={toast.action.href}
                onClick={() => dismiss(toast.id)}
                className="focus-ring font-mono text-xs font-medium text-text-accent uppercase hover:underline"
              >
                {toast.action.label}
              </Link>
            )}
            {(toast.error || toast.action) && (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
                className="focus-ring grid h-8 w-8 place-items-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
