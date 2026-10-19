'use client';
import { useEffect, useRef, useState } from 'react';
import { api, useSession } from '@/lib/session';
import { useAuthModal } from './modals';
import { useToast } from './toast';
import { Button } from './ui';
import { Field } from './auth';
import { Choice } from './moderation-policy';

export function ContentWarning({
  warning,
  children,
}: {
  warning?: string | null;
  children: React.ReactNode;
}) {
  if (!warning) return <>{children}</>;
  return (
    <details
      className="group/warning my-2 rounded-sm border border-border-default p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <summary className="cursor-pointer text-sm">
        Content warning: {warning} — reveal content
      </summary>
      <div className="mt-2 blur-md group-open/warning:blur-none">{children}</div>
    </details>
  );
}
export function useReport(targetType: 'post' | 'account', target: string) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState('spam'),
    [details, setDetails] = useState(''),
    [busy, setBusy] = useState(false);
  const { account } = useSession();
  const openAuth = useAuthModal();
  const toast = useToast();
  return {
    openReport: () => (account ? setOpen(true) : openAuth()),
    dialog: open && (
      <div
        className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-label={`Report ${targetType}`}
          className="w-full max-w-md space-y-4 rounded-sm bg-bg-default p-5 shadow-xl"
        >
          <h2 className="text-xl">Report {targetType}</h2>
          <p className="text-sm text-text-secondary">
            Send this to this instance’s moderators. A report does not remove anything onchain.
          </p>
          <Choice
            label="Reason"
            value={reason}
            options={['spam', 'harassment', 'illegal', 'other'].map((v) => [v, v])}
            onChange={setReason}
          />
          <Field
            name="reportDetails"
            label="Details (optional)"
            value={details}
            onChange={setDetails}
            multiline
            maxLength={1000}
          />
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/api/reports', {
                    method: 'POST',
                    body: { targetType, target, reason, details },
                  });
                  toast.show('Report sent to this instance’s moderators');
                  setOpen(false);
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send report
            </Button>
          </div>
        </section>
      </div>
    ),
  };
}

type TurnstileAPI = {
  render: (node: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
export function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | undefined,
      disposed = false;
    const render = () => {
      const sdk = (window as Window & { turnstile?: TurnstileAPI }).turnstile;
      if (!disposed && !id && sdk && node.current)
        id = sdk.render(node.current, {
          sitekey: siteKey,
          action: 'signup',
          callback: onToken,
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken(''),
        });
    };
    let script = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
    if (!script) {
      script = document.createElement('script');
      script.dataset.turnstile = 'true';
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    render();
    return () => {
      disposed = true;
      script?.removeEventListener('load', render);
      if (id) (window as Window & { turnstile?: TurnstileAPI }).turnstile?.remove(id);
    };
  }, [siteKey, onToken]);
  return (
    <div>
      <p className="mb-2 text-sm">Complete the sign-up bot check</p>
      <div ref={node} />
    </div>
  );
}
