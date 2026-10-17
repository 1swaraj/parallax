'use client';

import type { AccountView, PostView } from '@lens-monad/protocol';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { Address } from 'viem';
import { indexerGet } from './indexer';
import { api } from './session';

/*
 * Likes are Parallax's own, kept by its server (/api/likes): Lens V3 has no onchain likes. Other Lens apps don't
 * see them.
 */

export type LikeState = { count: number; liked: boolean };

export const LIKES_KEY = 'likes';

const NONE: LikeState = { count: 0, liked: false };

// Every post on screen asks for its like state; one request per tick serves them all.
let pending = new Map<string, ((state: LikeState) => void)[]>();
let scheduled: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  const batch = pending;
  pending = new Map();
  scheduled = null;
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const states = await api<Record<string, LikeState>>(`/api/likes?ids=${chunk.join(',')}`).catch(
      () => ({}) as Record<string, LikeState>
    );
    for (const id of chunk) {
      for (const resolve of batch.get(id) ?? []) {
        resolve(states[id] ?? NONE);
      }
    }
  }
}

function loadLike(postId: string) {
  return new Promise<LikeState>((resolve) => {
    pending.set(postId, [...(pending.get(postId) ?? []), resolve]);
    scheduled ??= setTimeout(flush, 15);
  });
}

export function useLike(postId: string) {
  return useQuery({
    queryKey: [LIKES_KEY, postId],
    queryFn: () => loadLike(postId),
    staleTime: 30_000,
  });
}

/** Likes and unlikes, optimistically: the heart fills before the server answers. */
export function useToggleLike(postId: string) {
  const queryClient = useQueryClient();
  const key = [LIKES_KEY, postId];
  return useMutation({
    mutationFn: (like: boolean) =>
      api<LikeState>('/api/likes', { method: like ? 'POST' : 'DELETE', body: { postId } }),
    onMutate: async (like) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<LikeState>(key) ?? NONE;
      queryClient.setQueryData<LikeState>(key, {
        liked: like,
        count: Math.max(0, previous.count + (like === previous.liked ? 0 : like ? 1 : -1)),
      });
      return { previous };
    },
    onSuccess: (state) => queryClient.setQueryData<LikeState>(key, state),
    onError: (_error, _like, context) => {
      if (context) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [LIKES_KEY, 'mine'] }),
  });
}

/** Posts by id, from the indexer, for lists the indexer doesn't keep. */
async function postsByIds(ids: string[], viewer: Address | null): Promise<PostView[]> {
  if (ids.length === 0) {
    return [];
  }
  const query = new URLSearchParams({ ids: ids.join(',') });
  if (viewer) {
    query.set('viewer', viewer);
  }
  return (await indexerGet<{ items: PostView[] }>(`/posts?${query}`)).items;
}

/** The signed-in account's liked posts, newest like first: the Likes tab of their profile. */
export function useMyLikedPosts(viewer: Address | null) {
  return useInfiniteQuery({
    queryKey: [LIKES_KEY, 'mine', viewer],
    queryFn: async ({ pageParam }) => {
      const page = await api<{ items: { postId: string }[]; next: string | null }>(
        `/api/likes/mine${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`
      );
      return {
        items: await postsByIds(
          page.items.map((item) => item.postId),
          viewer
        ),
        next: page.next,
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: viewer !== null,
  });
}

export type LikeNotification = {
  id: string;
  post: PostView;
  likers: AccountView[];
  /** Seconds, like the indexer's timestamps. */
  createdAt: string;
};

/** Likes on the account's posts, grouped per post like X: "Ana and 3 others liked your post". */
export function useReceivedLikes(account: Address | null, since: string | null) {
  return useQuery({
    queryKey: [LIKES_KEY, 'received', account, since],
    queryFn: async () => {
      const received = await api<{
        items: { postId: string; liker: Address; likedAt: string }[];
        unread: number;
      }>(`/api/likes/received?limit=50${since ? `&since=${encodeURIComponent(since)}` : ''}`);
      const postIds = [...new Set(received.items.map((item) => item.postId))];
      const likerAddresses = [...new Set(received.items.map((item) => item.liker))];
      const [posts, likers] = await Promise.all([
        postsByIds(postIds, account),
        Promise.all(
          likerAddresses.map((address) =>
            indexerGet<{ account: AccountView }>(`/accounts/${address}`)
              .then((profile) => profile.account)
              .catch(() => null)
          )
        ),
      ]);
      const postById = new Map(posts.map((post) => [post.id, post]));
      const likerByAddress = new Map(
        likers
          .filter((liker) => liker !== null)
          .map((liker) => [liker.address.toLowerCase(), liker])
      );
      const groups: LikeNotification[] = [];
      for (const postId of postIds) {
        const post = postById.get(postId);
        const likes = received.items.filter((item) => item.postId === postId);
        const accounts = likes
          .map((like) => likerByAddress.get(like.liker.toLowerCase()))
          .filter((liker) => liker !== undefined);
        if (post && accounts.length > 0) {
          groups.push({
            id: `like:${postId}`,
            post,
            likers: accounts,
            createdAt: String(Math.floor(new Date(likes[0]!.likedAt).getTime() / 1000)),
          });
        }
      }
      return { groups, unread: received.unread };
    },
    enabled: account !== null,
    refetchInterval: 20_000,
    retry: false,
  });
}

/** How many likes arrived since the user last opened notifications, for the badge. */
export function useUnreadLikes(account: Address | null, since: string | null) {
  return useQuery({
    queryKey: [LIKES_KEY, 'unread', account, since],
    queryFn: async () =>
      (
        await api<{ unread: number }>(
          `/api/likes/received?limit=1${since ? `&since=${encodeURIComponent(since)}` : ''}`
        )
      ).unread,
    enabled: account !== null,
    refetchInterval: 20_000,
    retry: false,
  });
}

const SEEN_KEY = 'parallax-likes-seen';
const listeners = new Set<() => void>();

/** When the user last opened notifications, for unread likes (ISO, per account, in this browser). */
export function useLikesSeen(account: Address | null): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (account ? window.localStorage.getItem(`${SEEN_KEY}:${account.toLowerCase()}`) : null),
    () => null
  );
}

export function markLikesSeen(account: Address) {
  window.localStorage.setItem(`${SEEN_KEY}:${account.toLowerCase()}`, new Date().toISOString());
  listeners.forEach((listener) => listener());
}
