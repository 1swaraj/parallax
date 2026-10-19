import { localTestChain } from '../../../packages/protocol/test/local-chain';
// End-to-end test of the indexer's API, against the local node (`pnpm chain`) and a running indexer (`pnpm indexer`):
// three Accounts sign up through the relayer, then post, mention, reply, quote, repost, follow, block and delete, and
// the test reads back what the API serves about it.

import {
  accountFactoryAbi,
  accountMetadata,
  blockAccount,
  createAccountWithUsernameArgs,
  createPost,
  deletePost,
  feedAbi,
  follow,
  getDeployment,
  lensFactoryAbi,
  repost,
  sponsorRouterAbi,
  textOnlyPost,
  toDataURI,
  unfollow,
  type AccountCall,
  type AccountView,
  type NotificationView,
  type Page,
  type PostView,
  type ProfileView,
  type Relationship,
  type ThreadView,
  type TrendView,
} from '@lens-monad/protocol';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:42069';
// Anvil's 4th account, the relayer DeployLaunch allowlists on chain 31337.
const RELAYER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
// Sign-ups and a few dozen transactions, each waited for by the indexer.
const TIMEOUT = 120_000;

const { contracts } = getDeployment(localTestChain.id);
const publicClient = createPublicClient({
  chain: localTestChain,
  transport: http(localTestChain.rpcUrls.default.http[0]),
  pollingInterval: 100,
});
const relayer = createWalletClient({
  chain: localTestChain,
  transport: http(localTestChain.rpcUrls.default.http[0]),
  account: privateKeyToAccount(RELAYER_KEY),
  pollingInterval: 100,
});

type Actor = { account: Address; username: string };

async function api<T>(path: string, status = 200): Promise<T> {
  const response = await fetch(`${INDEXER_URL}${path}`);
  expect(response.status, `GET ${path}`).toBe(status);
  return (await response.json()) as T;
}

/** Waits until the indexer processed the receipt's block. */
async function indexed(receipt: TransactionReceipt) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await api<Record<string, { block: { number: number } }>>('/status');
    if (Object.values(status).every((chain) => BigInt(chain.block.number) >= receipt.blockNumber)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The indexer didn't reach block ${receipt.blockNumber}`);
}

async function signUp(label: string): Promise<Actor> {
  const username = `${label}${Date.now().toString(36)}`;
  const hash = await relayer.writeContract({
    address: contracts.LensFactory,
    abi: lensFactoryAbi,
    functionName: 'createAccountWithUsernameFree',
    args: createAccountWithUsernameArgs({
      namespace: contracts.LensGlobalNamespace,
      owner: privateKeyToAccount(generatePrivateKey()).address,
      username,
      metadataURI: toDataURI(accountMetadata({ name: label })),
      sponsorRouter: contracts.SponsorRouter,
    }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  const [created] = parseEventLogs({
    abi: accountFactoryAbi,
    eventName: 'Lens_Account_Created',
    logs: receipt.logs,
  });
  await indexed(receipt);
  return { account: created!.args.account, username };
}

/** Sends the call through SponsorRouter, and waits for the indexer. */
async function sponsored(actor: Actor, call: AccountCall) {
  const hash = await relayer.writeContract({
    address: contracts.SponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'execute',
    args: [actor.account, call.target, call.data],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  await indexed(receipt);
  return receipt;
}

/** Posts and returns the new post's id. */
async function postAs(
  actor: Actor,
  content: string | null,
  reference?: Parameters<typeof createPost>[3] | { kind: 'repost'; postId: bigint }
) {
  const call =
    reference?.kind === 'repost'
      ? repost(contracts.LensGlobalFeed, actor.account, reference.postId)
      : createPost(
          contracts.LensGlobalFeed,
          actor.account,
          toDataURI(textOnlyPost(content!)),
          reference
        );
  const receipt = await sponsored(actor, call);
  const [event] = parseEventLogs({
    abi: feedAbi,
    eventName: 'Lens_Feed_PostCreated',
    logs: receipt.logs,
  });
  return event!.args.postId.toString();
}

function notifications(actor: Actor, query = '') {
  return api<Page<NotificationView>>(`/notifications?account=${actor.account}&limit=100${query}`);
}

/** Notifications as comparable summaries: type, actor and post. */
function summaries(page: Page<NotificationView>) {
  return page.items.map((item) => ({
    type: item.type,
    actor: item.actor.address,
    post: item.post?.id ?? null,
  }));
}

describe('Indexer API', () => {
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  // A token only this run's posts contain, for search.
  const token = `tok${Date.now().toString(36)}`;
  // Hashtags only this run uses: #hot is a prefix of #hotter, so a substring search would mix them.
  const tagPrefix = `h${Date.now().toString(36)}`;
  const tags = { hot: `${tagPrefix}hot`, hotter: `${tagPrefix}hotter`, fresh: `${tagPrefix}fresh` };
  const ids = {} as Record<
    | 'root'
    | 'reply'
    | 'quote'
    | 'carolReply'
    | 'repost'
    | 'repostOfCarol'
    | 'selfReply'
    | 'deep1'
    | 'deep2'
    | 'mention',
    string
  >;

  beforeAll(async () => {
    const code = await publicClient
      .getCode({ address: contracts.SponsorRouter })
      .catch(() => undefined);
    if (!code || code === '0x') {
      throw new Error('Lens is not deployed on http://127.0.0.1:8545, run `pnpm chain` first');
    }
    const ready = await fetch(`${INDEXER_URL}/ready`).catch(() => null);
    if (ready?.status !== 200) {
      throw new Error(`The indexer isn't ready on ${INDEXER_URL}, run \`pnpm indexer\` first`);
    }
    alice = await signUp('alice');
    bob = await signUp('bob');
    carol = await signUp('carol');

    // Alice mentions Bob and Carol (twice: as a mention, and inside a URL), herself, and nobody. She tags the post
    // #hot twice (in two cases), and #fresh inside a URL.
    ids.root = await postAs(
      alice,
      `gm @${bob.username} @${carol.username} @${alice.username} @nobody${token} ` +
        `https://example.com/@${carol.username} ${token}_a ` +
        `#${tags.hot.toUpperCase()} #${tags.hot} https://example.com/#${tags.fresh}`
    );
    // Bob replies mentioning Alice: she gets the reply, not a mention too.
    ids.reply = await postAs(bob, `@${alice.username} gm ${token}xa #${tags.hot}`, {
      kind: 'reply',
      postId: BigInt(ids.root),
    });
    ids.quote = await postAs(carol, `look ${token} #${tags.fresh}`, {
      kind: 'quote',
      postId: BigInt(ids.root),
    });
    ids.carolReply = await postAs(carol, `hi alice #${tags.hot}`, {
      kind: 'reply',
      postId: BigInt(ids.root),
    });
    ids.repost = await postAs(bob, null, { kind: 'repost', postId: BigInt(ids.root) });
    ids.repostOfCarol = await postAs(bob, null, { kind: 'repost', postId: BigInt(ids.quote) });
    ids.selfReply = await postAs(alice, `me again @${alice.username} #${tags.hotter}`, {
      kind: 'reply',
      postId: BigInt(ids.root),
    });
    // A thread: root <- reply (Bob) <- deep1 (Alice) <- deep2 (Bob).
    ids.deep1 = await postAs(alice, 'deeper', { kind: 'reply', postId: BigInt(ids.reply) });
    ids.deep2 = await postAs(bob, 'deepest', { kind: 'reply', postId: BigInt(ids.deep1) });
    // Bob mentions Alice and tags #fresh, then deletes the post.
    ids.mention = await postAs(bob, `oops @${alice.username} #${tags.fresh}`);
    await sponsored(bob, deletePost(contracts.LensGlobalFeed, BigInt(ids.mention)));

    // Carol follows Alice, unfollows, then Bob and Carol follow her.
    await sponsored(carol, follow(contracts.LensGlobalGraph, carol.account, alice.account));
    await sponsored(carol, unfollow(contracts.LensGlobalGraph, carol.account, alice.account));
    await sponsored(bob, follow(contracts.LensGlobalGraph, bob.account, alice.account));
    await sponsored(carol, follow(contracts.LensGlobalGraph, carol.account, alice.account));
  }, TIMEOUT);

  it('notifies mentions once per post, never the author, and only usernames that exist', async () => {
    expect(summaries(await notifications(bob))).toEqual([
      { type: 'reply', actor: alice.account, post: ids.deep1 },
      { type: 'mention', actor: alice.account, post: ids.root },
    ]);
    expect(summaries(await notifications(carol))).toEqual([
      { type: 'repost', actor: bob.account, post: ids.quote },
      { type: 'mention', actor: alice.account, post: ids.root },
    ]);
  });

  it("notifies follows, replies, quotes and reposts, newest first, without the actor's deleted posts", async () => {
    const page = await notifications(alice);
    expect(summaries(page)).toEqual([
      { type: 'follow', actor: carol.account, post: null },
      { type: 'follow', actor: bob.account, post: null },
      { type: 'reply', actor: bob.account, post: ids.deep2 },
      { type: 'repost', actor: bob.account, post: ids.root },
      { type: 'reply', actor: carol.account, post: ids.carolReply },
      { type: 'quote', actor: carol.account, post: ids.quote },
      { type: 'reply', actor: bob.account, post: ids.reply },
    ]);
    expect(page.next).toBeNull();
    for (const item of page.items) {
      expect(item.id).toMatch(/^\d+:\d+$/);
      expect(Number(item.createdAt)).toBeGreaterThan(0);
    }
    // The repost shows Alice's post, with her as viewer.
    const reposted = page.items.find((item) => item.type === 'repost')!;
    expect(reposted.post?.author.address).toBe(alice.account);
    expect(reposted.post?.viewerRepostId).toBeNull();
  });

  it('filters mentions and replies, and pages with cursors', async () => {
    expect(summaries(await notifications(alice, '&type=mentions'))).toEqual([
      { type: 'reply', actor: bob.account, post: ids.deep2 },
      { type: 'reply', actor: carol.account, post: ids.carolReply },
      { type: 'reply', actor: bob.account, post: ids.reply },
    ]);
    const all = await notifications(alice);
    const first = await api<Page<NotificationView>>(
      `/notifications?account=${alice.account}&limit=3`
    );
    expect(first.items.map((item) => item.id)).toEqual(
      all.items.slice(0, 3).map((item) => item.id)
    );
    expect(first.next).toBe(all.items[2]!.id);
    const second = await api<Page<NotificationView>>(
      `/notifications?account=${alice.account}&limit=3&cursor=${first.next}`
    );
    expect(second.items.map((item) => item.id)).toEqual(
      all.items.slice(3, 6).map((item) => item.id)
    );
    await api(`/notifications?account=${alice.account}&type=likes`, 400);
    await api(`/notifications?account=${alice.account}&cursor=nope`, 400);
    await api('/notifications', 400);
  });

  it('counts unread notifications since a cursor', async () => {
    const { items } = await notifications(alice);
    const unread = (since?: string) =>
      api<{ count: number }>(
        `/notifications/unread?account=${alice.account}${since ? `&since=${since}` : ''}`
      );
    expect(await unread()).toEqual({ count: items.length });
    expect(await unread(items[0]!.id)).toEqual({ count: 0 });
    expect(await unread(items[2]!.id)).toEqual({ count: 2 });
    await api(`/notifications/unread?account=${alice.account}&since=1`, 400);
  });

  it("sets the viewer's repost on posts and reposts", async () => {
    const thread = await api<ThreadView>(`/posts/${ids.root}?viewer=${bob.account}`);
    expect(thread.post.viewerRepostId).toBe(ids.repost);
    const bobPosts = await api<Page<PostView>>(
      `/accounts/${bob.account}/posts?viewer=${bob.account}&limit=100`
    );
    const repostItem = bobPosts.items.find((item) => item.id === ids.repost)!;
    expect(repostItem.repostedPostId).toBe(ids.root);
    expect(repostItem.viewerRepostId).toBe(ids.repost);
    expect(repostItem.reposted?.viewerRepostId).toBe(ids.repost);
    expect(
      (await api<ThreadView>(`/posts/${ids.root}?viewer=${alice.account}`)).post.viewerRepostId
    ).toBeNull();
    expect((await api<ThreadView>(`/posts/${ids.root}`)).post.viewerRepostId).toBeNull();
  });

  it("serves the viewer's posts and those of who they follow, without replies", async () => {
    const page = await api<Page<PostView>>(`/timeline/following?viewer=${bob.account}`);
    expect(page.items.map((post) => post.id)).toEqual([ids.repostOfCarol, ids.repost, ids.root]);
    expect(page.next).toBeNull();
    await api('/timeline/following', 400);
  });

  it('serves threads with their ancestors, root first', async () => {
    const thread = await api<ThreadView>(`/posts/${ids.deep2}`);
    expect(thread.post.id).toBe(ids.deep2);
    expect(thread.ancestors.map((post) => post.id)).toEqual([ids.root, ids.reply, ids.deep1]);
    expect(thread.replies).toEqual([]);
    const root = await api<ThreadView>(`/posts/${ids.root}`);
    expect(root.ancestors).toEqual([]);
    expect(root.replies.map((post) => post.id)).toEqual([ids.reply, ids.carolReply, ids.selfReply]);
    await api('/posts/nope', 400);
  });

  it('searches content case-insensitively, with % and _ taken literally', async () => {
    const search = async (q: string, viewer?: Actor) =>
      (
        await api<Page<PostView>>(
          `/search/posts?q=${encodeURIComponent(q)}${viewer ? `&viewer=${viewer.account}` : ''}`
        )
      ).items.map((post) => post.id);
    expect(await search(`${token}_a`)).toEqual([ids.root]);
    expect(await search(`${token.toUpperCase()}_A`)).toEqual([ids.root]);
    expect(await search(`${token}%a`)).toEqual([]);
    expect(await search(token)).toEqual([ids.quote, ids.reply, ids.root]);
    const paged = await api<Page<PostView>>(`/search/posts?q=${token}&limit=2`);
    expect(paged.items.map((post) => post.id)).toEqual([ids.quote, ids.reply]);
    const rest = await api<Page<PostView>>(`/search/posts?q=${token}&limit=2&cursor=${paged.next}`);
    expect(rest.items.map((post) => post.id)).toEqual([ids.root]);
    expect(rest.next).toBeNull();
  });

  it('searches a single #hashtag by exact tag, case-insensitively, newest first', async () => {
    const search = async (q: string, query = '') =>
      api<Page<PostView>>(`/search/posts?q=${encodeURIComponent(q)}${query}`);
    // Not selfReply's #hotter, which a substring search would match.
    expect((await search(`#${tags.hot.toUpperCase()}`)).items.map((post) => post.id)).toEqual([
      ids.carolReply,
      ids.reply,
      ids.root,
    ]);
    const first = await search(`#${tags.hot}`, '&limit=2');
    expect(first.items.map((post) => post.id)).toEqual([ids.carolReply, ids.reply]);
    const rest = await search(`#${tags.hot}`, `&limit=2&cursor=${first.next}`);
    expect(rest.items.map((post) => post.id)).toEqual([ids.root]);
    expect(rest.next).toBeNull();
    // Neither the deleted post, nor the root's URL.
    expect((await search(`#${tags.fresh}`)).items.map((post) => post.id)).toEqual([ids.quote]);
  });

  it('trends hashtags by live posts in the window, ties to the most recent', async () => {
    const { items } = await api<{ items: TrendView[] }>('/trends?limit=100&hours=1');
    expect(items.filter((item) => item.tag.startsWith(tagPrefix))).toEqual([
      { tag: tags.hot, posts: 3 },
      { tag: tags.hotter, posts: 1 },
      { tag: tags.fresh, posts: 1 },
    ]);
    const counts = items.map((item) => item.posts);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect((await api<{ items: TrendView[] }>('/trends')).items.length).toBeLessThanOrEqual(5);
    await api('/trends?hours=0', 400);
    await api('/trends?hours=169', 400);
  });

  it('pages followers, newest first', async () => {
    const first = await api<Page<AccountView>>(`/accounts/${alice.username}/followers?limit=1`);
    expect(first.items.map((item) => item.address)).toEqual([carol.account]);
    const second = await api<Page<AccountView>>(
      `/accounts/${alice.username}/followers?limit=1&cursor=${first.next}`
    );
    expect(second.items.map((item) => item.address)).toEqual([bob.account]);
    expect(second.next).toBeNull();
    const following = await api<Page<AccountView>>(`/accounts/${bob.username}/following`);
    expect(following.items.map((item) => item.address)).toEqual([alice.account]);
  });

  describe('once Alice blocked Carol', () => {
    beforeAll(async () => {
      await sponsored(
        alice,
        blockAccount(contracts.AccountBlockingRule, alice.account, carol.account)
      );
    }, TIMEOUT);

    it("hides Carol's notifications from Alice", async () => {
      expect(summaries(await notifications(alice))).toEqual([
        { type: 'follow', actor: bob.account, post: null },
        { type: 'reply', actor: bob.account, post: ids.deep2 },
        { type: 'repost', actor: bob.account, post: ids.root },
        { type: 'reply', actor: bob.account, post: ids.reply },
      ]);
    });

    it("hides Carol's posts and their reposts from Alice's timeline, not from others'", async () => {
      const timeline = async (viewer: Actor) =>
        (await api<Page<PostView>>(`/timeline?viewer=${viewer.account}&limit=100`)).items.map(
          (post) => post.id
        );
      const ofAlice = await timeline(alice);
      expect(ofAlice).toContain(ids.repost);
      expect(ofAlice).not.toContain(ids.quote);
      expect(ofAlice).not.toContain(ids.repostOfCarol);
      const ofBob = await timeline(bob);
      expect(ofBob).toContain(ids.quote);
      expect(ofBob).toContain(ids.repostOfCarol);
    });

    it("hides Carol's posts from Alice's search and replies, not from others'", async () => {
      const search = (viewer: Actor) =>
        api<Page<PostView>>(`/search/posts?q=${token}&viewer=${viewer.account}`);
      expect((await search(alice)).items.map((post) => post.id)).toEqual([ids.reply, ids.root]);
      expect((await search(bob)).items.map((post) => post.id)).toEqual([
        ids.quote,
        ids.reply,
        ids.root,
      ]);
      const thread = await api<ThreadView>(`/posts/${ids.root}?viewer=${alice.account}`);
      expect(thread.replies.map((post) => post.id)).toEqual([ids.reply, ids.selfReply]);
      const hashtag = await api<Page<PostView>>(
        `/search/posts?q=${encodeURIComponent(`#${tags.hot}`)}&viewer=${alice.account}`
      );
      expect(hashtag.items.map((post) => post.id)).toEqual([ids.reply, ids.root]);
    });

    it('reports relationships in batch', async () => {
      const relationships = await api<Record<Address, Relationship>>(
        `/relationships?viewer=${alice.account}&accounts=${bob.account},${carol.account.toLowerCase()}`
      );
      expect(relationships).toEqual({
        [bob.account]: { following: false, followedBy: true, blocking: false, blockedBy: false },
        [carol.account]: { following: false, followedBy: true, blocking: true, blockedBy: false },
      });
      const ofCarol = await api<Record<Address, Relationship>>(
        `/relationships?viewer=${carol.account}&accounts=${alice.account}`
      );
      expect(ofCarol[alice.account]).toEqual({
        following: true,
        followedBy: false,
        blocking: false,
        blockedBy: true,
      });
      const profile = await api<ProfileView>(`/accounts/${carol.username}?viewer=${alice.account}`);
      expect(profile.relationship).toEqual(relationships[carol.account]);
      const tooMany = Array.from({ length: 101 }, () => bob.account).join(',');
      await api(`/relationships?viewer=${alice.account}&accounts=${tooMany}`, 400);
      await api(`/relationships?viewer=${alice.account}&accounts=0x12`, 400);
      await api(`/relationships?accounts=${bob.account}`, 400);
    });

    it('suggests the most followed accounts, minus the viewer, who they follow, and blocks', async () => {
      const suggested = async (viewer: Actor) =>
        (await api<Page<AccountView>>(`/accounts/suggested?viewer=${viewer.account}&limit=100`))
          .items;
      for (const [viewer, excluded] of [
        [alice, [alice, carol]],
        [bob, [bob, alice]],
        [carol, [carol, alice]],
      ] as const) {
        const items = await suggested(viewer);
        expect(items.length).toBeGreaterThan(0);
        const addresses = items.map((item) => item.address);
        for (const account of excluded) {
          expect(addresses).not.toContain(account.account);
        }
        const followers = items.map((item) => item.followers);
        expect(followers).toEqual([...followers].sort((a, b) => b - a));
      }
    });
  });

  it("hides a repost's notification once it's undone, and clears the viewer's repost", async () => {
    await sponsored(bob, deletePost(contracts.LensGlobalFeed, BigInt(ids.repost)));
    expect(summaries(await notifications(alice)).map((item) => item.type)).not.toContain('repost');
    const thread = await api<ThreadView>(`/posts/${ids.root}?viewer=${bob.account}`);
    expect(thread.post.viewerRepostId).toBeNull();
  });
});
