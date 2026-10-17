'use client';

import type { NotificationView } from '@lens-monad/protocol';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, displayName, profileHref, RelativeTime, RichText } from '@/components/account';
import { Icon, type IconName } from '@/components/icons';
import { useAuthModal } from '@/components/modals';
import { PostCard } from '@/components/post';
import {
  Button,
  EmptyState,
  ErrorState,
  FeedSkeleton,
  LoadMore,
  PageHeader,
  Tabs,
} from '@/components/ui';
import { markNotificationsSeen, useNotifications } from '@/lib/indexer';
import { markLikesSeen, useLikesSeen, useReceivedLikes, type LikeNotification } from '@/lib/likes';
import { useSession } from '@/lib/session';
import { usePageTitle } from '@/lib/title';

/** A row for things done to you: an icon, who did it, what. Replies, quotes and mentions show as posts instead. */
function ActivityRow({
  icon,
  href,
  actors,
  text,
  createdAt,
  excerpt,
}: {
  icon: IconName;
  href: string;
  actors: NotificationView['actor'][];
  text: string;
  createdAt: string;
  excerpt?: string | null;
}) {
  const [first, ...others] = actors;
  return (
    <Link
      href={href}
      className="focus-ring flex gap-3 border-b border-border-default px-4 py-3 transition-colors duration-150 hover:bg-bg-hover"
    >
      <div className="flex w-10 shrink-0 justify-end pt-1">
        <Icon name={icon} size={22} filled className="text-text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex gap-1">
          {actors.slice(0, 6).map((actor) => (
            <Avatar key={actor.address} account={actor} size={32} />
          ))}
        </div>
        <p className="mt-2 text-sm text-text-primary">
          <span className="font-semibold">{first ? displayName(first) : 'Someone'}</span>
          {others.length > 0 &&
            ` and ${others.length} ${others.length === 1 ? 'other' : 'others'}`}{' '}
          {text}
          <span className="text-text-tertiary"> · </span>
          <RelativeTime seconds={createdAt} />
        </p>
        {excerpt && (
          <RichText text={excerpt} className="mt-1 line-clamp-3 text-sm text-text-tertiary" />
        )}
      </div>
    </Link>
  );
}

function IndexerNotification({ notification }: { notification: NotificationView }) {
  if (notification.type === 'follow') {
    return (
      <ActivityRow
        icon="user"
        href={profileHref(notification.actor)}
        actors={[notification.actor]}
        text="followed you"
        createdAt={notification.createdAt}
      />
    );
  }
  if (notification.type === 'repost') {
    return (
      <ActivityRow
        icon="repost"
        href={notification.post ? `/p/${notification.post.id}` : profileHref(notification.actor)}
        actors={[notification.actor]}
        text="reposted your post"
        createdAt={notification.createdAt}
        excerpt={notification.post?.content}
      />
    );
  }
  return notification.post ? <PostCard post={notification.post} /> : null;
}

function LikeRow({ group }: { group: LikeNotification }) {
  return (
    <ActivityRow
      icon="heart"
      href={`/p/${group.post.id}`}
      actors={group.likers}
      text="liked your post"
      createdAt={group.createdAt}
      excerpt={group.post.content}
    />
  );
}

type Item =
  | { kind: 'indexer'; notification: NotificationView; time: number }
  | { kind: 'like'; group: LikeNotification; time: number };

export default function NotificationsPage() {
  const { account } = useSession();
  const openAuth = useAuthModal();
  const [tab, setTab] = useState<'all' | 'mentions'>('all');
  const query = useNotifications(account, tab);
  const likesSeen = useLikesSeen(account);
  // Likes as of opening the page: marking them seen shouldn't reshuffle the list.
  const [openedAt] = useState(likesSeen);
  const { data: likes } = useReceivedLikes(tab === 'all' ? account : null, openedAt);
  const newest = query.data?.pages[0]?.items[0]?.id;
  usePageTitle('Notifications');

  // Opening the page reads everything that's on it.
  useEffect(() => {
    if (account && newest && tab === 'all') {
      markNotificationsSeen(account, newest);
    }
  }, [account, newest, tab]);
  useEffect(() => {
    if (account && tab === 'all' && likes) {
      markLikesSeen(account);
    }
  }, [account, tab, likes]);

  const notifications = query.data?.pages.flatMap((page) => page.items) ?? [];
  const oldestLoaded = notifications.at(-1)?.createdAt;
  const items: Item[] = [
    ...notifications.map((notification) => ({
      kind: 'indexer' as const,
      notification,
      time: Number(notification.createdAt),
    })),
    // Likes older than the loaded notifications wait until those load, so the order stays right.
    ...(likes?.groups ?? [])
      .filter(
        (group) =>
          !query.hasNextPage || !oldestLoaded || Number(group.createdAt) >= Number(oldestLoaded)
      )
      .map((group) => ({ kind: 'like' as const, group, time: Number(group.createdAt) })),
  ].sort((a, b) => b.time - a.time);

  return (
    <>
      <PageHeader title="Notifications">
        <Tabs
          tabs={[
            { id: 'all', label: 'All' },
            { id: 'mentions', label: 'Mentions' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </PageHeader>
      {!account ? (
        <EmptyState
          icon="bell"
          title="Sign in to see notifications"
          action={
            <Button variant="primary" onClick={openAuth}>
              Sign in
            </Button>
          }
        >
          Follows, likes, replies, reposts, quotes and mentions show up here.
        </EmptyState>
      ) : query.isPending ? (
        <FeedSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon="bell" title={tab === 'all' ? 'Nothing to see yet' : 'No mentions yet'}>
          {tab === 'all'
            ? 'When someone follows you, likes, replies to, reposts or quotes your posts, you see it here.'
            : 'When someone mentions you or replies to you, you see it here.'}
        </EmptyState>
      ) : (
        <div>
          {items.map((item) =>
            item.kind === 'like' ? (
              <LikeRow key={item.group.id} group={item.group} />
            ) : (
              <IndexerNotification key={item.notification.id} notification={item.notification} />
            )
          )}
          {query.hasNextPage && (
            <LoadMore
              onVisible={() => !query.isFetchingNextPage && void query.fetchNextPage()}
              loading={query.isFetchingNextPage}
            />
          )}
        </div>
      )}
    </>
  );
}
