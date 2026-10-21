'use client';

import type { MirrorStatusView } from '@lens-monad/protocol';
import { MIRROR } from '@/lib/config';
import { useMirrorStatus } from '@/lib/indexer';
import { useNetwork } from '@/lib/runtime-config';
import { compactNumber } from './account';

// Mirror mode (lib/config.ts): what tells readers they're on a read-only copy of Lens, and how far the copy is.

const LINK = 'text-text-accent underline underline-offset-2 hover:decoration-text-accent';

const MONTH_YEAR = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Below this share of Lens Chain's posts, the history is still syncing. Some posts have no state to import. */
const SYNCED = 0.999;

/**
 * How much of Lens Chain's history is in: imported posts of the post count Lens Chain's feed carries, and how far back
 * they go, as the backfill runs newest first.
 */
export function HistorySync({ status }: { status: MirrorStatusView }) {
  const total = status.lensChainPosts === null ? null : Number(status.lensChainPosts);
  const share = total ? Math.min(1, status.posts / total) : 0;
  if (total && share >= SYNCED) {
    return <p className="mono-caps mt-2 text-[11px] text-text-tertiary">History synced</p>;
  }
  const oldest = status.oldestPostAt
    ? MONTH_YEAR.format(new Date(Number(status.oldestPostAt) * 1000))
    : null;
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-3 text-xs text-text-secondary">
        <span>
          <span className="font-semibold text-text-primary">History syncing:</span>{' '}
          {total
            ? `${compactNumber(status.posts)} of ${compactNumber(total)} posts copied`
            : 'starting'}
          {oldest && `, back to ${oldest}`}. New posts show up as they happen.
        </span>
        {total ? <span className="font-mono tabular-nums">{(share * 100).toFixed(1)}%</span> : null}
      </div>
      <div
        role="progressbar"
        aria-label="History synced"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(share * 100)}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-border-default"
      >
        <div className="h-full bg-accent-primary" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/** The top of every page in mirror mode: a read-only preview, where to post instead, and the history's sync. */
export function MirrorBanner() {
  const { chain } = useNetwork();
  const { data: status } = useMirrorStatus(MIRROR);
  if (!MIRROR) {
    return null;
  }
  return (
    <aside
      aria-label="Read-only preview"
      className="relative border-b border-border-default bg-status-info-bg py-3 pr-4 pl-5"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-status-info" />
      <p className="text-sm text-text-primary">
        <span className="font-semibold">Read-only preview.</span> This is Lens data mirrored from
        Lens Chain to {chain.name}. To post, follow or like, use a Lens app such as{' '}
        <a href="https://hey.xyz" target="_blank" rel="noreferrer" className={LINK}>
          Hey
        </a>{' '}
        or{' '}
        <a href="https://orb.club" target="_blank" rel="noreferrer" className={LINK}>
          Orb
        </a>
        .
      </p>
      {status && <HistorySync status={status} />}
    </aside>
  );
}
