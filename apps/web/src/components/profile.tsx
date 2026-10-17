'use client';

import { blockAccount, unblockAccount, type ProfileView } from '@lens-monad/protocol';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { isAddressEqual } from 'viem';
import { useLensActions } from '@/lib/actions';
import { contracts } from '@/lib/config';
import { IndexerError, useAccountPosts, useFollowList, useProfile } from '@/lib/indexer';
import { useSession } from '@/lib/session';
import { useMyLikedPosts } from '@/lib/likes';
import { usePageTitle } from '@/lib/title';
import {
  atHandle,
  Avatar,
  compactNumber,
  displayName,
  FollowsYou,
  handleOf,
  joinedLabel,
  RichText,
  shortAddress,
} from './account';
import { FollowButton } from './follow-button';
import { Icon } from './icons';
import { AccountList, PostList } from './lists';
import { useConfirm, useEditProfile } from './modals';
import { useToast } from './toast';
import { Button, Dropdown, EmptyState, ErrorState, PageHeader, Spinner, Tabs } from './ui';

function ProfileActions({ profile }: { profile: ProfileView }) {
  const { account: viewer, run } = useLensActions();
  const editProfile = useEditProfile();
  const confirm = useConfirm();
  const toast = useToast();
  const { account, relationship } = profile;
  const isSelf = !!viewer && isAddressEqual(viewer, account.address);

  const toggleBlock = useMutation({
    mutationFn: (block: boolean) =>
      run((blocker) =>
        block
          ? blockAccount(contracts.AccountBlockingRule, blocker, account.address)
          : unblockAccount(contracts.AccountBlockingRule, blocker, account.address)
      ),
    onSuccess: (_, block) =>
      toast.show(block ? `You blocked ${atHandle(account)}` : `You unblocked ${atHandle(account)}`),
    onError: (error) => toast.error(error.message),
  });

  if (isSelf) {
    return <Button onClick={editProfile}>Edit profile</Button>;
  }
  return (
    <div className="flex items-center gap-2">
      <Dropdown
        items={[
          {
            label: 'Copy account address',
            icon: 'link',
            onSelect: () =>
              navigator.clipboard
                .writeText(account.address)
                .then(() => toast.show('Address copied')),
          },
          {
            label: relationship?.blocking
              ? `Unblock ${atHandle(account)}`
              : `Block ${atHandle(account)}`,
            icon: 'block',
            danger: !relationship?.blocking,
            hidden: !viewer,
            onSelect: () =>
              relationship?.blocking
                ? toggleBlock.mutate(false)
                : confirm({
                    title: `Block ${atHandle(account)}?`,
                    body: "They won't be able to follow you or reply to you, and their posts leave your timelines.",
                    action: 'Block',
                    danger: true,
                    onConfirm: () => toggleBlock.mutate(true),
                  }),
          },
        ]}
        trigger={({ toggle, open }) => (
          <Button size="icon" aria-label="More" aria-expanded={open} onClick={toggle}>
            <Icon name="more" size={18} />
          </Button>
        )}
      />
      {relationship?.blocking ? (
        <Button
          variant="destructive"
          disabled={toggleBlock.isPending}
          onClick={() => toggleBlock.mutate(false)}
        >
          Blocked
        </Button>
      ) : (
        <FollowButton target={account} relationship={relationship} primary />
      )}
    </div>
  );
}

function ProfileHeader({ profile }: { profile: ProfileView }) {
  const { account, relationship } = profile;
  const handle = handleOf(account);
  return (
    <div className="border-b border-border-default">
      {/* A flat band carrying the account's onchain identity, as metadata. */}
      <div className="dot-grid flex h-32 items-end justify-end border-b border-border-default bg-bg-subtle px-4 pb-3 sm:h-44">
        <span className="mono-caps text-[11px] leading-4 text-text-tertiary">
          Lens account · {shortAddress(account.address)}
        </span>
      </div>
      <div className="px-4 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="-mt-12 rounded-full border-4 border-bg-default bg-bg-default sm:-mt-16">
            <Avatar account={account} size={96} />
          </div>
          <div className="pt-3">
            <ProfileActions profile={profile} />
          </div>
        </div>
        <h2 className="mt-3 max-w-none truncate text-2xl leading-8">{displayName(account)}</h2>
        <div className="flex items-center text-sm text-text-tertiary">
          <span className="truncate">{atHandle(account)}</span>
          {relationship?.followedBy && <FollowsYou />}
        </div>
        {account.bio && (
          <RichText text={account.bio} className="mt-3 max-w-[65ch] text-base text-text-primary" />
        )}
        <div className="mt-3 flex items-center gap-1.5 text-sm text-text-tertiary">
          <Icon name="calendar" size={16} />
          {joinedLabel(account.createdAt)}
        </div>
        <div className="mt-3 flex gap-5 text-sm">
          <Link href={`/u/${handle}/following`} className="focus-ring hover:underline">
            <span className="font-mono font-medium text-text-primary tabular-nums">
              {compactNumber(account.following)}
            </span>{' '}
            <span className="text-text-tertiary">Following</span>
          </Link>
          <Link href={`/u/${handle}/followers`} className="focus-ring hover:underline">
            <span className="font-mono font-medium text-text-primary tabular-nums">
              {compactNumber(account.followers)}
            </span>{' '}
            <span className="text-text-tertiary">
              {account.followers === 1 ? 'Follower' : 'Followers'}
            </span>
          </Link>
        </div>
        {relationship?.blockedBy && (
          <p className="mt-3 text-sm text-text-secondary">
            {atHandle(account)} blocked you. You can&apos;t follow them or reply to their posts.
          </p>
        )}
      </div>
    </div>
  );
}

function useProfileOrError(handle: string) {
  const { account: viewer } = useSession();
  return useProfile(decodeURIComponent(handle), viewer);
}

function ProfileState({
  query,
  children,
}: {
  query: ReturnType<typeof useProfileOrError>;
  children: (profile: ProfileView) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <>
        <PageHeader title="Profile" back />
        <Spinner />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Profile" back />
        {query.error instanceof IndexerError && query.error.status === 404 ? (
          <EmptyState icon="user" title="This account doesn't exist">
            Check the username, or search for it in Explore.
          </EmptyState>
        ) : (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}
      </>
    );
  }
  return <>{children(query.data)}</>;
}

export function ProfilePage({ handle }: { handle: string }) {
  const query = useProfileOrError(handle);
  const { account: viewer } = useSession();
  const [tab, setTab] = useState<'posts' | 'replies' | 'likes'>('posts');
  const posts = useAccountPosts(handle, tab === 'replies', viewer);
  const isSelf = !!viewer && !!query.data && isAddressEqual(viewer, query.data.account.address);
  // Likes are private, like X's: only you see what you liked.
  const likes = useMyLikedPosts(isSelf && tab === 'likes' ? viewer : null);
  usePageTitle(
    query.data ? `${displayName(query.data.account)} (${atHandle(query.data.account)})` : null
  );

  return (
    <ProfileState query={query}>
      {(profile) => (
        <>
          <PageHeader
            title={displayName(profile.account)}
            meta={`${compactNumber(profile.account.posts)} ${profile.account.posts === 1 ? 'post' : 'posts'}`}
            back
          />
          <ProfileHeader profile={profile} />
          <Tabs
            tabs={[
              { id: 'posts' as const, label: 'Posts' },
              { id: 'replies' as const, label: 'Replies' },
              ...(isSelf ? [{ id: 'likes' as const, label: 'Likes' }] : []),
            ]}
            active={tab}
            onChange={setTab}
          />
          {tab === 'likes' && isSelf ? (
            <PostList
              query={likes}
              empty={
                <EmptyState icon="heart" title="You haven't liked any posts yet">
                  Tap the heart on any post to like it. Only you can see your likes.
                </EmptyState>
              }
            />
          ) : (
            <PostList
              query={posts}
              empty={
                <EmptyState icon="feather" title={`${atHandle(profile.account)} hasn't posted yet`}>
                  When they do, their posts show up here.
                </EmptyState>
              }
            />
          )}
        </>
      )}
    </ProfileState>
  );
}

export function FollowListPage({
  handle,
  direction,
}: {
  handle: string;
  direction: 'followers' | 'following';
}) {
  const query = useProfileOrError(handle);
  const list = useFollowList(handle, direction);
  usePageTitle(
    query.data
      ? `People ${direction === 'followers' ? 'following' : 'followed by'} ${atHandle(query.data.account)}`
      : null
  );
  return (
    <ProfileState query={query}>
      {(profile) => (
        <>
          <PageHeader title={displayName(profile.account)} meta={atHandle(profile.account)} back>
            <Tabs
              tabs={[
                { id: 'followers', label: 'Followers', href: `/u/${handle}/followers` },
                { id: 'following', label: 'Following', href: `/u/${handle}/following` },
              ]}
              active={direction}
            />
          </PageHeader>
          <AccountList
            query={list}
            empty={
              <EmptyState
                icon="follow"
                title={direction === 'followers' ? 'No followers yet' : 'Not following anyone yet'}
              >
                {direction === 'followers'
                  ? `When someone follows ${atHandle(profile.account)}, they show up here.`
                  : `When ${atHandle(profile.account)} follows someone, they show up here.`}
              </EmptyState>
            }
          />
        </>
      )}
    </ProfileState>
  );
}
