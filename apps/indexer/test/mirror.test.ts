// The mirror's handlers (src/mirror-handlers.ts) against an in-memory store: every importer event, records arriving
// out of order, and later imports updating earlier ones.

import { accountMetadata, textOnlyPost, toDataURI } from '@lens-monad/protocol';
import type { Context } from 'ponder:registry';
import { getAddress, zeroAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  account,
  block,
  follow,
  hashtag,
  mirrorPendingAccount,
  mirrorPendingPost,
  mirrorStatus,
  notification,
  post,
  username,
} from '../ponder.schema';
import {
  accountImported,
  accountMapped,
  blockImported,
  feedCountersImported,
  followImported,
  followPosition,
  postImported,
  postPosition,
  usernameImported,
} from '../src/mirror-handlers';
import { fakeDb } from './fake-db';

// Monad addresses of mirrored Accounts, and the Lens Chain addresses they were copied from.
const ALICE: Address = '0x00000000000000000000000000000000000a11ce';
const BOB: Address = '0x0000000000000000000000000000000000000b0b';
const CAROL: Address = '0x00000000000000000000000000000000000ca201';
const LENS_ALICE: Address = '0x0000000000000000000000000000000000a11ce1';
const OWNER: Address = '0x00000000000000000000000000000000000000e0';
const NEW_OWNER: Address = '0x00000000000000000000000000000000000000e1';

/** The mirror starts here (Monad time). History is from before, Lens Chain's new activity from after. */
const START = 1_800_000_000n;
const HISTORY = 1_700_000_000n;

type PostFields = {
  author: Address;
  contentURI?: string;
  rootPostId?: bigint;
  repliedPostId?: bigint;
  quotedPostId?: bigint;
  repostedPostId?: bigint;
  creationTimestamp: bigint;
  lastUpdatedTimestamp?: bigint;
  isDeleted?: boolean;
};

function text(content: string) {
  return toDataURI(textOnlyPost(content));
}

function mirror() {
  const { db, rows } = fakeDb(
    new Map<object, string[]>([
      [account, ['address']],
      [username, ['username']],
      [post, ['id']],
      [hashtag, ['tag', 'blockNumber', 'logIndex']],
      [follow, ['follower', 'followed']],
      [block, ['blocker', 'blocked']],
      [notification, ['recipient', 'blockNumber', 'logIndex']],
      [mirrorPendingAccount, ['address']],
      [mirrorPendingPost, ['id']],
      [mirrorStatus, ['id']],
    ])
  );
  // The Accounts' state, as readAccount() returns it at the import's block.
  const states = new Map<string, { owner: Address; metadataURI: string }>();
  const reads: string[] = [];
  const context = {
    db,
    client: {
      readContract: async ({
        address,
        functionName,
      }: {
        address: Address;
        functionName: string;
      }) => {
        reads.push(`${functionName}@${address}`);
        const state = states.get(address.toLowerCase());
        if (!state) {
          throw new Error(`No Account at ${address}`);
        }
        return { proxyAdminOwner: state.owner, managers: [], ...state };
      },
    },
  } as unknown as Context;
  let number = 1000n;
  const next = () => {
    number++;
    return { number, timestamp: START + number - 1001n };
  };
  const event = <args>(args: args, address: Address = zeroAddress) => ({
    args,
    block: next(),
    log: { address },
  });

  return {
    rows,
    reads,
    find: (table: object, key: Record<string, unknown>) => db.find(table, key),
    status: () => db.find(mirrorStatus, { id: 1 }),
    async importAccount(
      target: Address,
      state: { owner: Address; metadataURI: string },
      source?: Address
    ) {
      states.set(target.toLowerCase(), state);
      if (source) {
        await accountMapped(event({ source, target }), context);
      }
      await accountImported(event({ revision: 1n, stateHash: '0x' as const }, target), context);
    },
    assign: (name: string, assignedAccount: Address) =>
      usernameImported(event({ username: { username: name, assignedAccount } }), context),
    post: (id: bigint, fields: PostFields) =>
      postImported(
        event({
          postId: id,
          post: {
            postSequentialId: id,
            contentURI: '',
            rootPostId: fields.repliedPostId ?? id,
            repliedPostId: 0n,
            quotedPostId: 0n,
            repostedPostId: 0n,
            lastUpdatedTimestamp: fields.creationTimestamp,
            isDeleted: false,
            ...fields,
          },
          creationSource: zeroAddress,
        }),
        context
      ),
    counters: (postCount: bigint) => feedCountersImported(event({ postCount }), context),
    follow: (follower: Address, followed: Address, id: bigint, timestamp: bigint) =>
      followImported(event({ follower, followed, id, timestamp, active: true }), context),
    unfollow: (follower: Address, followed: Address) =>
      followImported(event({ follower, followed, id: 0n, timestamp: 0n, active: false }), context),
    block: (source: Address, target: Address, blocked: boolean) =>
      blockImported(event({ source, target, blocked }), context),
  };
}

describe('mirror accounts', () => {
  it('imports an Account with its owner and inline profile, read at the import, and its Lens Chain address', async () => {
    const m = mirror();
    await m.importAccount(
      getAddress(ALICE),
      { owner: getAddress(OWNER), metadataURI: toDataURI(accountMetadata({ name: 'Alice' })) },
      getAddress(LENS_ALICE)
    );
    expect(await m.find(account, { address: ALICE })).toMatchObject({
      owner: OWNER,
      name: 'Alice',
      bio: null,
      sponsored: false,
      followers: 0,
      lensChainAddress: LENS_ALICE,
    });
    expect(m.reads).toEqual([`readAccount@${ALICE}`]);
    expect(m.rows(mirrorPendingAccount)).toEqual([]);
    expect((await m.status())?.accounts).toBe(1);
  });

  it('takes a new owner and profile from a later import, without counting the Account twice', async () => {
    const m = mirror();
    await m.importAccount(ALICE, { owner: OWNER, metadataURI: toDataURI(accountMetadata({})) });
    await m.importAccount(ALICE, { owner: NEW_OWNER, metadataURI: 'lens://profile' });
    expect(await m.find(account, { address: ALICE })).toMatchObject({
      owner: NEW_OWNER,
      metadataUri: 'lens://profile',
      // Offchain metadata is the API's to read.
      name: null,
    });
    expect((await m.status())?.accounts).toBe(1);
  });
});

describe('mirror usernames', () => {
  it('assigns, moves and releases usernames as the importer does', async () => {
    const m = mirror();
    for (const address of [ALICE, BOB]) {
      await m.importAccount(address, { owner: OWNER, metadataURI: '' });
    }
    await m.assign('alice', ALICE);
    await m.assign('bob', BOB);
    expect((await m.find(account, { address: ALICE }))?.username).toBe('alice');

    // "alice" moves to Bob: Alice loses it, and it displaces Bob's "bob".
    await m.assign('alice', getAddress(BOB));
    expect((await m.find(account, { address: ALICE }))?.username).toBeNull();
    expect((await m.find(account, { address: BOB }))?.username).toBe('alice');
    expect(m.rows(username)).toEqual([{ username: 'alice', account: BOB }]);

    // Unassigned (or burned).
    await m.assign('alice', zeroAddress);
    expect((await m.find(account, { address: BOB }))?.username).toBeNull();
    expect(m.rows(username)).toEqual([]);
    expect((await m.status())?.usernames).toBe(0);
  });

  it('keeps the username of an Account that isn’t imported yet', async () => {
    const m = mirror();
    await m.assign('carol', CAROL);
    expect(await m.find(username, { username: 'carol' })).toEqual({
      username: 'carol',
      account: CAROL,
    });
    await m.importAccount(CAROL, { owner: OWNER, metadataURI: '' });
    expect((await m.find(account, { address: CAROL }))?.username).toBe('carol');
  });
});

describe('mirror posts', () => {
  it('orders posts by their Lens Chain time, whatever order they arrive in', async () => {
    const m = mirror();
    // History arrives newest first.
    await m.post(30n, {
      author: ALICE,
      creationTimestamp: HISTORY + 300n,
      contentURI: text('third'),
    });
    await m.post(20n, {
      author: ALICE,
      creationTimestamp: HISTORY + 200n,
      contentURI: text('second'),
    });
    await m.post(10n, {
      author: ALICE,
      creationTimestamp: HISTORY + 100n,
      contentURI: text('first'),
    });
    const order = m
      .rows(post)
      .sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? Number(a.logIndex) - Number(b.logIndex)
          : a.blockNumber! < b.blockNumber!
            ? -1
            : 1
      )
      .map((row) => row.content);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(await m.find(post, { id: 20n })).toMatchObject({
      createdAt: HISTORY + 200n,
      blockNumber: HISTORY + 200n,
      logIndex: 20,
    });
    expect(postPosition(HISTORY, 1_234_567_890_123n).logIndex).toBe(567_890_123);
  });

  it('counts replies, quotes and reposts that arrive before their post, and posts before their author', async () => {
    const m = mirror();
    await m.post(2n, {
      author: BOB,
      repliedPostId: 1n,
      creationTimestamp: HISTORY + 2n,
      contentURI: text('reply'),
    });
    await m.post(3n, {
      author: BOB,
      quotedPostId: 1n,
      creationTimestamp: HISTORY + 3n,
      contentURI: text('quote'),
    });
    await m.post(4n, { author: CAROL, repostedPostId: 1n, creationTimestamp: HISTORY + 4n });
    expect(await m.find(mirrorPendingPost, { id: 1n })).toEqual({
      id: 1n,
      replies: 1,
      reposts: 1,
      quotes: 1,
    });
    expect((await m.find(mirrorPendingAccount, { address: BOB }))?.posts).toBe(2);

    await m.post(1n, { author: ALICE, creationTimestamp: HISTORY + 1n, contentURI: text('root') });
    expect(await m.find(post, { id: 1n })).toMatchObject({ replies: 1, reposts: 1, quotes: 1 });
    expect(await m.find(post, { id: 2n })).toMatchObject({ rootPostId: 1n, repliedPostId: 1n });
    expect(m.rows(mirrorPendingPost)).toEqual([]);

    await m.importAccount(BOB, { owner: OWNER, metadataURI: '' });
    expect((await m.find(account, { address: BOB }))?.posts).toBe(2);
    expect(await m.find(mirrorPendingAccount, { address: BOB })).toBeNull();
  });

  it('applies edits and deletions from later imports', async () => {
    const m = mirror();
    await m.importAccount(ALICE, { owner: OWNER, metadataURI: '' });
    await m.post(1n, { author: ALICE, creationTimestamp: HISTORY, contentURI: text('root') });
    await m.post(2n, {
      author: ALICE,
      repliedPostId: 1n,
      creationTimestamp: HISTORY + 1n,
      contentURI: text('first take #old'),
    });
    expect(m.rows(hashtag).map((row) => row.tag)).toEqual(['old']);

    await m.post(2n, {
      author: ALICE,
      repliedPostId: 1n,
      creationTimestamp: HISTORY + 1n,
      lastUpdatedTimestamp: HISTORY + 50n,
      contentURI: text('second take #new'),
    });
    expect(await m.find(post, { id: 2n })).toMatchObject({
      content: 'second take #new',
      editedAt: HISTORY + 50n,
      deleted: false,
    });
    expect(m.rows(hashtag).map((row) => row.tag)).toEqual(['new']);

    await m.post(2n, {
      author: ALICE,
      repliedPostId: 1n,
      creationTimestamp: HISTORY + 1n,
      lastUpdatedTimestamp: HISTORY + 60n,
      contentURI: text('second take #new'),
      isDeleted: true,
    });
    expect((await m.find(post, { id: 2n }))?.deleted).toBe(true);
    expect((await m.find(post, { id: 1n }))?.replies).toBe(0);
    expect((await m.find(account, { address: ALICE }))?.posts).toBe(1);
    expect((await m.status())?.posts).toBe(2);
  });

  it('imports deleted posts without counting them', async () => {
    const m = mirror();
    await m.post(1n, { author: ALICE, creationTimestamp: HISTORY, contentURI: text('root') });
    await m.post(2n, {
      author: BOB,
      repliedPostId: 1n,
      creationTimestamp: HISTORY + 1n,
      contentURI: text('gone #tag'),
      isDeleted: true,
    });
    expect((await m.find(post, { id: 1n }))?.replies).toBe(0);
    expect(await m.find(mirrorPendingAccount, { address: BOB })).toBeNull();
    expect(m.rows(hashtag)).toEqual([]);
  });

  it('never notifies for history, and notifies replies, quotes, reposts and mentions after the start', async () => {
    const m = mirror();
    for (const address of [ALICE, BOB, CAROL]) {
      await m.importAccount(address, { owner: OWNER, metadataURI: '' });
    }
    await m.assign('carol', CAROL);
    await m.post(1n, { author: ALICE, creationTimestamp: HISTORY, contentURI: text('root') });
    await m.post(2n, {
      author: BOB,
      repliedPostId: 1n,
      creationTimestamp: HISTORY + 1n,
      contentURI: text('old reply, @lens/carol'),
    });
    expect(m.rows(notification)).toEqual([]);

    // Lens Chain's new activity, after the mirror started.
    await m.post(3n, {
      author: BOB,
      repliedPostId: 1n,
      creationTimestamp: START + 100n,
      contentURI: text('new reply, cc @lens/carol'),
    });
    await m.post(4n, {
      author: CAROL,
      quotedPostId: 1n,
      creationTimestamp: START + 101n,
      contentURI: text('quote'),
    });
    await m.post(5n, { author: CAROL, repostedPostId: 1n, creationTimestamp: START + 102n });
    expect(
      m.rows(notification).map(({ recipient, type, actor, postId, blockNumber }) => ({
        recipient,
        type,
        actor,
        postId,
        blockNumber,
      }))
    ).toEqual([
      { recipient: ALICE, type: 'reply', actor: BOB, postId: 3n, blockNumber: START + 100n },
      { recipient: CAROL, type: 'mention', actor: BOB, postId: 3n, blockNumber: START + 100n },
      { recipient: ALICE, type: 'quote', actor: CAROL, postId: 4n, blockNumber: START + 101n },
      { recipient: ALICE, type: 'repost', actor: CAROL, postId: 1n, blockNumber: START + 102n },
    ]);
  });

  it('notifies the author of a post that arrives after its new replies, quotes and reposts', async () => {
    const m = mirror();
    for (const address of [ALICE, BOB, CAROL]) {
      await m.importAccount(address, { owner: OWNER, metadataURI: '' });
    }
    await m.assign('alice', ALICE);
    // New activity on an old post of Alice's, which the backfill hasn't reached.
    await m.post(10n, {
      author: BOB,
      repliedPostId: 1n,
      rootPostId: 1n,
      creationTimestamp: START + 10n,
      contentURI: text('late to this, @lens/alice'),
    });
    await m.post(11n, { author: CAROL, quotedPostId: 1n, creationTimestamp: START + 11n });
    await m.post(12n, { author: CAROL, repostedPostId: 1n, creationTimestamp: START + 12n });
    await m.post(13n, {
      author: ALICE,
      repliedPostId: 1n,
      rootPostId: 1n,
      creationTimestamp: START + 13n,
    });
    // Bob's reply mentions Alice: the mention is all the mirror can tell her yet.
    expect(m.rows(notification).map(({ type }) => type)).toEqual(['mention']);

    await m.post(1n, { author: ALICE, creationTimestamp: HISTORY, contentURI: text('old post') });
    expect(
      m
        .rows(notification)
        .map(({ recipient, type, actor, postId }) => ({ recipient, type, actor, postId }))
    ).toEqual([
      // The reply outranks the mention, as when the post is in first.
      { recipient: ALICE, type: 'reply', actor: BOB, postId: 10n },
      { recipient: ALICE, type: 'quote', actor: CAROL, postId: 11n },
      { recipient: ALICE, type: 'repost', actor: CAROL, postId: 1n },
    ]);
    expect(await m.find(post, { id: 1n })).toMatchObject({ replies: 2, quotes: 1, reposts: 1 });
    expect(m.rows(mirrorPendingPost)).toEqual([]);
  });

  it('keeps NUL characters out of what Postgres stores', async () => {
    const m = mirror();
    await m.importAccount(ALICE, {
      owner: OWNER,
      metadataURI: toDataURI(accountMetadata({ name: 'Al\u0000ice', bio: 'b\u0000io' })),
    });
    expect(await m.find(account, { address: ALICE })).toMatchObject({ name: 'Alice', bio: 'bio' });
    const contentURI = `data:application/json,${encodeURIComponent(JSON.stringify({ lens: { content: 'g\u0000m #t\u0000ag' } }))}`;
    await m.post(1n, { author: ALICE, creationTimestamp: HISTORY, contentURI });
    const row = await m.find(post, { id: 1n });
    expect(row?.content).toBe('gm #tag');
    expect(row?.contentUri).toBe(contentURI);
    expect(m.rows(hashtag).map(({ tag }) => tag)).toEqual(['tag']);
    await m.assign('bad\u0000name', ALICE);
    expect((await m.find(account, { address: ALICE }))?.username).toBe('badname');
  });

  it('carries Lens Chain’s post count, and how far back the history goes', async () => {
    const m = mirror();
    await m.counters(21_400_000n);
    await m.post(9n, { author: ALICE, creationTimestamp: HISTORY + 900n });
    await m.post(5n, { author: ALICE, creationTimestamp: HISTORY + 500n });
    expect(await m.status()).toMatchObject({
      posts: 2,
      lensChainPosts: 21_400_000n,
      oldestPostAt: HISTORY + 500n,
      newestPostAt: HISTORY + 900n,
      notifySince: START,
    });
  });
});

describe('mirror follows', () => {
  it('follows, unfollows, and follows again under a new id', async () => {
    const m = mirror();
    for (const address of [ALICE, BOB]) {
      await m.importAccount(address, { owner: OWNER, metadataURI: '' });
    }
    await m.follow(getAddress(ALICE), getAddress(BOB), 7n, HISTORY);
    const position = followPosition(ALICE, BOB, HISTORY);
    expect(await m.find(follow, { follower: ALICE, followed: BOB })).toEqual({
      follower: ALICE,
      followed: BOB,
      followId: 7n,
      createdAt: HISTORY,
      blockNumber: HISTORY,
      logIndex: position.logIndex,
    });
    expect((await m.find(account, { address: BOB }))?.followers).toBe(1);
    expect((await m.find(account, { address: ALICE }))?.following).toBe(1);

    // The same follow again changes nothing.
    await m.follow(ALICE, BOB, 7n, HISTORY);
    expect((await m.find(account, { address: BOB }))?.followers).toBe(1);

    await m.unfollow(ALICE, BOB);
    expect(await m.find(follow, { follower: ALICE, followed: BOB })).toBeNull();
    expect((await m.find(account, { address: BOB }))?.followers).toBe(0);
    expect((await m.find(account, { address: ALICE }))?.following).toBe(0);

    // An unfollow of what isn't followed changes nothing either.
    await m.unfollow(ALICE, BOB);
    expect((await m.find(account, { address: BOB }))?.followers).toBe(0);

    await m.follow(ALICE, BOB, 8n, HISTORY + 10n);
    await m.follow(ALICE, BOB, 9n, HISTORY + 20n);
    expect(await m.find(follow, { follower: ALICE, followed: BOB })).toMatchObject({
      followId: 9n,
      createdAt: HISTORY + 20n,
    });
    expect((await m.find(account, { address: BOB }))?.followers).toBe(1);
    expect((await m.status())?.follows).toBe(1);
  });

  it('notifies new follows only, and takes an unfollow’s notification away', async () => {
    const m = mirror();
    await m.follow(ALICE, BOB, 1n, HISTORY);
    expect(m.rows(notification)).toEqual([]);
    await m.follow(CAROL, BOB, 2n, START + 5n);
    expect(m.rows(notification)).toMatchObject([
      { recipient: BOB, type: 'follow', actor: CAROL, createdAt: START + 5n },
    ]);
    await m.unfollow(CAROL, BOB);
    expect(m.rows(notification)).toEqual([]);
  });

  it('counts follows of Accounts that aren’t imported yet', async () => {
    const m = mirror();
    await m.follow(ALICE, BOB, 1n, HISTORY);
    await m.follow(CAROL, BOB, 2n, HISTORY);
    await m.unfollow(CAROL, BOB);
    expect(await m.find(mirrorPendingAccount, { address: BOB })).toMatchObject({ followers: 1 });
    await m.importAccount(BOB, { owner: OWNER, metadataURI: '' });
    await m.importAccount(ALICE, { owner: OWNER, metadataURI: '' });
    expect((await m.find(account, { address: BOB }))?.followers).toBe(1);
    expect((await m.find(account, { address: ALICE }))?.following).toBe(1);
  });
});

describe('mirror blocks', () => {
  it('blocks and unblocks', async () => {
    const m = mirror();
    await m.block(getAddress(ALICE), BOB, true);
    await m.block(ALICE, BOB, true);
    expect(m.rows(block)).toMatchObject([{ blocker: ALICE, blocked: BOB }]);
    await m.block(ALICE, CAROL, false);
    await m.block(ALICE, BOB, false);
    expect(m.rows(block)).toEqual([]);
    expect((await m.status())?.blocks).toBe(0);
  });
});
