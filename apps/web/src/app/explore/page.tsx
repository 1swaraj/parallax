'use client';

import type { Page } from '@lens-monad/protocol';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AccountRow } from '@/components/account';
import { PostList } from '@/components/lists';
import { SearchBox } from '@/components/shell';
import { EmptyState, ErrorState, PageHeader, Spinner, Tabs } from '@/components/ui';
import {
  useAccountSearch,
  useRelationships,
  useSearchPosts,
  useSuggestedAccounts,
} from '@/lib/indexer';
import { MIRROR } from '@/lib/config';
import { useSession } from '@/lib/session';
import { usePageTitle } from '@/lib/title';
import type { AccountView } from '@lens-monad/protocol';

type Tab = 'people' | 'posts';

function People({
  title,
  query,
  empty,
}: {
  title?: string;
  query: { data?: Page<AccountView>; isPending: boolean; error: Error | null; refetch: () => void };
  empty: React.ReactNode;
}) {
  const { account } = useSession();
  const items = query.data?.items ?? [];
  const { data: relationships } = useRelationships(
    account,
    items.map((item) => item.address)
  );
  if (query.isPending) {
    return <Spinner />;
  }
  if (query.error) {
    return <ErrorState error={query.error} onRetry={query.refetch} />;
  }
  if (items.length === 0) {
    return <>{empty}</>;
  }
  return (
    <section>
      {title && <h2 className="px-4 pt-4 pb-2 text-xl leading-7">{title}</h2>}
      {items.map((item) => (
        <AccountRow
          key={item.address}
          account={item}
          showBio
          relationship={relationships?.[item.address.toLowerCase()] ?? null}
        />
      ))}
    </section>
  );
}

function Explore() {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.get('q')?.trim() ?? '';
  const tab: Tab = (params.get('tab') as Tab) ?? (search.startsWith('#') ? 'posts' : 'people');
  const { account } = useSession();
  const people = useAccountSearch(tab === 'people' ? search.replace(/^@/, '').toLowerCase() : '');
  const posts = useSearchPosts(tab === 'posts' ? search : '', account);
  const suggested = useSuggestedAccounts(account, 30);
  usePageTitle(search ? `${search} - Search` : 'Explore');

  const setTab = (next: Tab) =>
    router.replace(`/explore?q=${encodeURIComponent(search)}&tab=${next}`, { scroll: false });

  return (
    <>
      <PageHeader title="Explore">
        <div className="border-b border-border-default px-4 pb-3">
          <SearchBox initial={search} autoFocus={!search} />
        </div>
        {search && (
          <Tabs
            tabs={[
              { id: 'people', label: 'People' },
              { id: 'posts', label: 'Posts' },
            ]}
            active={tab}
            onChange={setTab}
          />
        )}
      </PageHeader>
      {!search ? (
        <People
          title={MIRROR ? 'Popular on Lens' : 'Who to follow'}
          query={suggested}
          empty={
            <EmptyState icon="user" title="No one here yet">
              {MIRROR
                ? 'Accounts show up here as the mirror imports them from Lens Chain.'
                : 'Accounts show up here as people join.'}
            </EmptyState>
          }
        />
      ) : tab === 'people' ? (
        <People
          query={people}
          empty={
            <EmptyState icon="search" title={`No results for "${search}"`}>
              People search matches the start of usernames. Try the Posts tab to search what people
              wrote.
            </EmptyState>
          }
        />
      ) : (
        <PostList
          query={posts}
          empty={
            <EmptyState icon="search" title={`No results for "${search}"`}>
              {MIRROR
                ? 'Search reads the posts whose text is onchain: most of Lens Chain\u2019s is offchain, so search people instead.'
                : 'Try another word, or check the spelling.'}
            </EmptyState>
          }
        />
      )}
    </>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Explore />
    </Suspense>
  );
}
