'use client';

import { MIRROR } from '@/lib/config';
import { IndexerError, useThread } from '@/lib/indexer';
import { useSession } from '@/lib/session';
import { usePageTitle } from '@/lib/title';
import { displayName } from './account';
import { Composer } from './composer';
import { FocusPost, PostCard } from './post';
import { EmptyState, ErrorState, FeedSkeleton, PageHeader } from './ui';

/** A post with what it replies to (root first, linked by the thread line), a reply box, and its replies. */
export function ThreadPage({ id }: { id: string }) {
  const { account } = useSession();
  const { data, isPending, error, refetch } = useThread(id, account);
  usePageTitle(data ? `Post by ${displayName(data.post.author)}` : 'Post');

  return (
    <>
      <PageHeader title="Post" back />
      {isPending ? (
        <FeedSkeleton rows={2} />
      ) : error ? (
        error instanceof IndexerError && error.status === 404 ? (
          <EmptyState icon="search" title="This post doesn't exist">
            It may have been deleted, or the link is wrong.
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => refetch()} />
        )
      ) : (
        <>
          {data.ancestors.map((ancestor, index) => (
            <PostCard key={ancestor.id} post={ancestor} lineAbove={index > 0} lineBelow />
          ))}
          {data.post.deleted ? (
            <div className="border-b border-border-default px-4 py-3">
              <div className="rounded-sm bg-bg-subtle px-4 py-3 text-sm text-text-tertiary">
                {data.post.moderation?.hidden
                  ? 'Hidden by moderators'
                  : 'This post is unavailable.'}
              </div>
            </div>
          ) : (
            <FocusPost post={data.post} lineAbove={data.ancestors.length > 0} />
          )}
          {!data.post.deleted && !MIRROR && (
            <div className="border-b border-border-default">
              <Composer replyTo={data.post} variant="reply" />
            </div>
          )}
          {data.replies.map((reply) => (
            <PostCard key={reply.id} post={reply} />
          ))}
          {data.replies.length === 0 && !data.post.deleted && (
            <p className="mono-caps py-8 text-center text-[11px] text-text-tertiary">
              No replies yet
            </p>
          )}
        </>
      )}
    </>
  );
}
