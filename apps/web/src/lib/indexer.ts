'use client';

import type {
  AccountView,
  NotificationView,
  Page,
  PostView,
  ProfileView,
  Relationship,
  ThreadView,
} from '@lens-monad/protocol';
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { Address } from 'viem';

/** All indexer queries start with this key, so a write can refresh them all once the indexer caught up. */
export const INDEXER_KEY = 'indexer';

export class IndexerError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function indexerGet<T>(path: string): Promise<T> {
  const response = await fetch(`/indexer${path}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new IndexerError(response.status, body?.error ?? `Indexer error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function query(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const string = search.toString();
  return string ? `?${string}` : '';
}

const notFound = (count: number, error: Error) =>
  !(error instanceof IndexerError && error.status === 404) && count < 2;

function usePages<T>(key: unknown[], path: (cursor: string | null) => string, enabled = true) {
  return useInfiniteQuery({
    queryKey: [INDEXER_KEY, ...key],
    queryFn: ({ pageParam }) => indexerGet<Page<T>>(path(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled,
  });
}

export function useTimeline(viewer: Address | null) {
  return usePages<PostView>(
    ['timeline', viewer],
    (cursor) => `/timeline${query({ viewer, cursor })}`
  );
}

export function useFollowingTimeline(viewer: Address | null) {
  return usePages<PostView>(
    ['timeline', 'following', viewer],
    (cursor) => `/timeline/following${query({ viewer, cursor })}`,
    viewer !== null
  );
}

/** The newest post of a timeline, polled, for the "Show new posts" pill. */
export function useLatestPostId(feed: 'everyone' | 'following', viewer: Address | null) {
  return useQuery({
    queryKey: [INDEXER_KEY, 'latest', feed, viewer],
    queryFn: async () => {
      const path = feed === 'following' ? '/timeline/following' : '/timeline';
      const page = await indexerGet<Page<PostView>>(`${path}${query({ viewer, limit: 1 })}`);
      return page.items[0]?.id ?? null;
    },
    refetchInterval: 12_000,
    enabled: feed === 'everyone' || viewer !== null,
  });
}

export function useAccountPosts(handle: string, replies: boolean, viewer: Address | null) {
  return usePages<PostView>(
    ['posts', handle, replies, viewer],
    (cursor) => `/accounts/${handle}/posts${query({ replies, viewer, cursor })}`
  );
}

export function useSearchPosts(search: string, viewer: Address | null) {
  return usePages<PostView>(
    ['search', search, viewer],
    (cursor) => `/search/posts${query({ q: search, viewer, cursor })}`,
    search.length > 0
  );
}

export function useProfile(handle: string | null, viewer: Address | null) {
  return useQuery({
    queryKey: [INDEXER_KEY, 'profile', handle?.toLowerCase(), viewer],
    queryFn: () => indexerGet<ProfileView>(`/accounts/${handle}${query({ viewer })}`),
    enabled: handle !== null,
    retry: notFound,
  });
}

export function useThread(id: string, viewer: Address | null) {
  return useQuery({
    queryKey: [INDEXER_KEY, 'thread', id, viewer],
    queryFn: () => indexerGet<ThreadView>(`/posts/${id}${query({ viewer })}`),
    retry: notFound,
  });
}

export function useAccountSearch(search: string) {
  return useQuery({
    queryKey: [INDEXER_KEY, 'accounts', search],
    queryFn: () => indexerGet<Page<AccountView>>(`/accounts${query({ q: search, limit: 30 })}`),
    enabled: search.length > 0,
  });
}

export function useSuggestedAccounts(viewer: Address | null, limit = 3) {
  return useQuery({
    queryKey: [INDEXER_KEY, 'suggested', viewer, limit],
    queryFn: () => indexerGet<Page<AccountView>>(`/accounts/suggested${query({ viewer, limit })}`),
  });
}

/** Trending hashtags. An indexer without /trends yet just means no panel. */
export function useTrends() {
  return useQuery({
    queryKey: [INDEXER_KEY, 'trends'],
    queryFn: async () =>
      (await indexerGet<{ items: { tag: string; posts: number }[] }>('/trends?limit=5')).items,
    retry: false,
    refetchInterval: 60_000,
  });
}

export function useFollowList(handle: string, direction: 'followers' | 'following') {
  return usePages<AccountView>(
    [direction, handle],
    (cursor) => `/accounts/${handle}/${direction}${query({ cursor, limit: 50 })}`
  );
}

/** The viewer's relationships to a list of accounts, in one request. */
export function useRelationships(viewer: Address | null, accounts: Address[]) {
  const sorted = [...new Set(accounts.map((account) => account.toLowerCase()))].sort();
  return useQuery({
    queryKey: [INDEXER_KEY, 'relationships', viewer, sorted],
    queryFn: async () => {
      const result = await indexerGet<Record<string, Relationship>>(
        `/relationships${query({ viewer, accounts: sorted.join(',') })}`
      );
      return Object.fromEntries(
        Object.entries(result).map(([address, relationship]) => [
          address.toLowerCase(),
          relationship,
        ])
      );
    },
    enabled: viewer !== null && sorted.length > 0,
  });
}

export function useNotifications(account: Address | null, type: 'all' | 'mentions') {
  return usePages<NotificationView>(
    ['notifications', account, type],
    (cursor) => `/notifications${query({ account, type, cursor })}`,
    account !== null
  );
}

const SEEN_KEY = 'lens:notifications-seen';
const seenListeners = new Set<() => void>();

/** The newest notification the user has seen, per account, in this browser. */
export function useLastSeenNotification(account: Address | null): string | null {
  return useSyncExternalStore(
    (listener) => {
      seenListeners.add(listener);
      return () => seenListeners.delete(listener);
    },
    () => (account ? window.localStorage.getItem(`${SEEN_KEY}:${account.toLowerCase()}`) : null),
    () => null
  );
}

export function markNotificationsSeen(account: Address, id: string) {
  window.localStorage.setItem(`${SEEN_KEY}:${account.toLowerCase()}`, id);
  seenListeners.forEach((listener) => listener());
}

export function useUnreadNotifications(account: Address | null, seen: string | null) {
  return useQuery({
    queryKey: [INDEXER_KEY, 'unread', account, seen],
    queryFn: async () =>
      (
        await indexerGet<{ count: number }>(
          `/notifications/unread${query({ account, since: seen })}`
        )
      ).count,
    enabled: account !== null,
    refetchInterval: 20_000,
  });
}

/** Waits until the indexer processed `blockNumber`, then refreshes every indexer query. */
export async function waitForIndexer(
  queryClient: QueryClient,
  blockNumber: bigint,
  timeoutMs = 30_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await indexerGet<Record<string, { block: { number: number } }>>('/status').catch(
      () => null
    );
    const indexed = status
      ? Math.min(...Object.values(status).map((chain) => chain.block.number))
      : -1;
    if (BigInt(indexed) >= blockNumber) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await queryClient.invalidateQueries({ queryKey: [INDEXER_KEY] });
}
