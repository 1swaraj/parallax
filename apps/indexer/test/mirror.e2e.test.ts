// End-to-end test of mirror mode's API, against the local mirror (`pnpm mirror:chain`, which imports
// scripts/mirror-seed.ts's slice of Lens Chain) and the indexer in mirror mode (`PONDER_MIRROR=true pnpm indexer`):
// what the importers' events became, as the app reads it.

import type {
  AccountView,
  MirrorStatusView,
  NotificationView,
  Page,
  PostView,
  ProfileView,
  Relationship,
  ThreadView,
} from '@lens-monad/protocol';
import { describe, expect, it } from 'vitest';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:42069';
// The seed's demo wallet, anvil's 10th account.
const DEMO_WALLET = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';

async function api<T>(path: string, status = 200): Promise<T> {
  const response = await fetch(`${INDEXER_URL}${path}`);
  expect(response.status, `GET ${path}`).toBe(status);
  return (await response.json()) as T;
}

const profile = (handle: string) => api<ProfileView>(`/accounts/${handle}`);
const content = (post: PostView) => (post.reposted ?? post).content;

describe('mirror mode, end to end', () => {
  it('says how far the import is', async () => {
    const status = await api<MirrorStatusView>('/mirror');
    expect(status).toMatchObject({
      accounts: 9,
      posts: 22,
      lensChainPosts: '22',
      follows: 20,
      usernames: 9,
      blocks: 1,
    });
    expect(Number(status.notifySince)).toBeGreaterThan(Number(status.oldestPostAt));
  });

  it('orders the Everyone timeline by Lens Chain time, without replies or followerless authors', async () => {
    const { items } = await api<Page<PostView>>('/timeline?limit=50');
    const times = items.map((post) => Number(post.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(items.every((post) => post.repliedPostId === null)).toBe(true);
    expect(items.map(content)).not.toContain('Claim free MON now at free-mon.example #airdrop');
    // Nor does search, whose hashtags the app's trends recount.
    for (const q of ['%23airdrop', 'Claim']) {
      expect((await api<Page<PostView>>(`/search/posts?q=${q}`)).items).toEqual([]);
    }
    // The repost and the reply arrived before their post: its counts are all there.
    const zine = items.find(
      (post) => !post.reposted && post.content?.startsWith('Working on a zine')
    )!;
    expect(zine).toMatchObject({ replies: 2, reposts: 1, quotes: 0 });
    // Lens v2's flat metadata, an article's title, and media as links.
    expect(items.map(content)).toEqual(
      expect.arrayContaining([
        'Reading list for the week: The Dispossessed, Ursula K. Le Guin. #bookclub',
        expect.stringMatching(/^What a mirror is for\n\nA mirror lets you read/),
      ])
    );
    expect(items.find((post) => post.content?.startsWith('Talk recording'))?.media).toMatchObject({
      kind: 'video',
      url: expect.stringMatching(/^https:\/\/ipfs\.io\/ipfs\//),
    });
    const offchain = items.find((post) => post.author.username === 'marco_p' && !post.content)!;
    expect(offchain.media).toMatchObject({
      kind: 'metadata',
      url: expect.stringMatching(/^https:\/\/api\.grove\.storage\//),
    });
  });

  it('applies the edits and deletions of later imports', async () => {
    const zoe = await api<Page<PostView>>('/accounts/zoe_onchain/posts');
    expect(zoe.items.find((post) => post.content?.includes('your posters'))).toMatchObject({
      content: '@lens/ana_lima your posters are great. Ordered two!',
      editedAt: expect.any(String),
    });
    const samir = await api<Page<PostView>>('/accounts/samir_dev/posts?replies=true');
    expect(samir.items.map(content)).not.toContain('oops, wrong account');
  });

  it('finds a wallet’s Accounts, and keeps where each was mirrored from', async () => {
    const owned = await api<Page<AccountView>>(`/accounts?owner=${DEMO_WALLET}`);
    expect(owned.items.map((account) => account.username)).toEqual(['ana_lima', 'ana_studio']);
    const ana = (await profile('ana_lima')).account;
    expect(ana).toMatchObject({ followers: 5, following: 4, posts: 2, owner: DEMO_WALLET });
    expect(ana.lensChainAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The name moved to ana_studio, and Marco's profile is offchain and can't be read locally.
    await api('/accounts/ana_posters', 404);
    expect((await profile('marco_p')).account.name).toBeNull();
  });

  it('notifies only what happened after the mirror started', async () => {
    const ana = (await profile('ana_lima')).account;
    const { items } = await api<Page<NotificationView>>(`/notifications?account=${ana.address}`);
    expect(items.map((item) => [item.type, item.actor.username])).toEqual([
      ['quote', 'zoe_onchain'],
      ['reply', 'kai_lens'],
    ]);
  });

  it('keeps the blocks still in place', async () => {
    const [ana, kai, claims] = await Promise.all(
      ['ana_lima', 'kai_lens', 'free_mon_claims'].map(
        async (handle) => (await profile(handle)).account
      )
    );
    const blocking = async (viewer: AccountView) =>
      (
        await api<Record<string, Relationship>>(
          `/relationships?viewer=${viewer.address}&accounts=${claims!.address}`
        )
      )[claims!.address]!.blocking;
    expect(await blocking(ana!)).toBe(true);
    expect(await blocking(kai!)).toBe(false);
  });

  it('serves threads, root first', async () => {
    const { items } = await api<Page<PostView>>('/accounts/kai_lens/posts');
    const root = items.find((post) => post.content?.startsWith('Lens v3 notes'))!;
    const thread = await api<ThreadView>(`/posts/${root.id}`);
    expect(thread.replies.map((reply) => reply.content)).toEqual([
      'Accounts own their followers: the Graph is a primitive any app can read.',
    ]);
  });
});
