'use client';

import type { AccountView, Page, PostView } from '@lens-monad/protocol';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';
import { useRelationships } from '@/lib/indexer';
import { useSession } from '@/lib/session';
import { AccountRow } from './account';
import { PostCard } from './post';
import { ErrorState, FeedSkeleton, LoadMore, Spinner } from './ui';

type Pages<T> = UseInfiniteQueryResult<InfiniteData<Page<T>>>;

function useLoadMore<T>(query: Pages<T>) {
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  return useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
}

/** A feed of posts, loading more as it scrolls. */
export function PostList({ query, empty }: { query: Pages<PostView>; empty: ReactNode }) {
  const loadMore = useLoadMore(query);
  if (query.isPending) {
    return <FeedSkeleton />;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const posts = query.data.pages.flatMap((page) => page.items);
  if (posts.length === 0) {
    return <>{empty}</>;
  }
  return (
    <div>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      {query.hasNextPage ? (
        <LoadMore onVisible={loadMore} loading={query.isFetchingNextPage} />
      ) : (
        <p className="mono-caps py-8 text-center text-[11px] text-text-tertiary">
          You&apos;re all caught up
        </p>
      )}
    </div>
  );
}

/** A list of people, with their relationship to the viewer loaded in one request. */
export function AccountList({ query, empty }: { query: Pages<AccountView>; empty: ReactNode }) {
  const { account } = useSession();
  const loadMore = useLoadMore(query);
  const accounts = query.data?.pages.flatMap((page) => page.items) ?? [];
  const { data: relationships } = useRelationships(
    account,
    accounts.map((item) => item.address)
  );
  if (query.isPending) {
    return <Spinner />;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (accounts.length === 0) {
    return <>{empty}</>;
  }
  return (
    <div>
      {accounts.map((item) => (
        <AccountRow
          key={item.address}
          account={item}
          showBio
          relationship={relationships?.[item.address.toLowerCase()] ?? null}
        />
      ))}
      {query.hasNextPage && <LoadMore onVisible={loadMore} loading={query.isFetchingNextPage} />}
    </div>
  );
}

/** X's pill when newer posts exist than the ones on screen. */
export function NewPostsPill({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  if (!visible) {
    return null;
  }
  return (
    <div className="sticky top-[106px] z-10 flex h-0 justify-center">
      <button
        type="button"
        onClick={onClick}
        className="animate-float focus-ring mt-3 flex h-8 items-center gap-2 rounded-full bg-accent-primary px-4 font-mono text-xs font-medium text-text-on-accent uppercase shadow-float"
      >
        <span aria-hidden>↑</span> Show new posts
      </button>
    </div>
  );
}
