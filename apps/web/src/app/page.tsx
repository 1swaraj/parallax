'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Composer } from '@/components/composer';
import { NewPostsPill, PostList } from '@/components/lists';
import { useAuthModal } from '@/components/modals';
import { Button, buttonClassName, EmptyState, PageHeader, Tabs } from '@/components/ui';
import { APP_NAME } from '@/lib/brand';
import { useFollowingTimeline, useLatestPostId, useTimeline } from '@/lib/indexer';
import { useSession } from '@/lib/session';
import { usePageTitle } from '@/lib/title';

type Feed = 'everyone' | 'following';

export default function HomePage() {
  const { owner, account } = useSession();
  const openAuth = useAuthModal();
  const [feed, setFeed] = useState<Feed>('everyone');
  const active: Feed = account ? feed : 'everyone';
  const everyone = useTimeline(account);
  const following = useFollowingTimeline(account);
  const query = active === 'following' ? following : everyone;
  const { data: latest } = useLatestPostId(active, account);
  const shown = new Set(query.data?.pages.flatMap((page) => page.items.map((post) => post.id)));
  usePageTitle('Home');

  return (
    <>
      <PageHeader title="Home" hideTitle={!!account}>
        {account && (
          <Tabs
            tabs={[
              { id: 'everyone', label: 'Everyone' },
              { id: 'following', label: 'Following' },
            ]}
            active={active}
            onChange={setFeed}
          />
        )}
      </PageHeader>
      <NewPostsPill
        visible={!!latest && shown.size > 0 && !shown.has(latest) && !query.isFetching}
        onClick={() => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          void query.refetch();
        }}
      />
      {owner && !account && (
        <div className="flex items-center justify-between gap-4 border-b border-border-default bg-bg-elevated px-4 py-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">Pick your username</p>
            <p className="text-sm text-text-secondary">
              Your wallet is signed in. Create your Lens account to post and follow.
            </p>
          </div>
          <Button variant="primary" onClick={openAuth}>
            Create account
          </Button>
        </div>
      )}
      <div className="max-sm:hidden">
        <Composer />
      </div>
      <PostList
        query={query}
        empty={
          active === 'following' ? (
            <EmptyState
              icon="follow"
              title="Your timeline is empty"
              action={
                <Link href="/explore" className={buttonClassName()}>
                  Find people to follow
                </Link>
              }
            >
              Posts from the people you follow show up here.
            </EmptyState>
          ) : (
            <EmptyState icon="feather" title="No posts yet">
              Be the first to post on {APP_NAME}.
            </EmptyState>
          )
        }
      />
    </>
  );
}
