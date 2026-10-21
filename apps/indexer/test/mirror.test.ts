// The mirror's handlers (src/mirror-handlers.ts) against an in-memory store: every importer event, records arriving
// out of order, and later imports updating earlier ones.

import {
  accountMetadata,
  migrationAccountDeployerAbi,
  textOnlyPost,
  toDataURI,
} from '@lens-monad/protocol';
import type { Context } from 'ponder:registry';
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbiParameters,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
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
  importedState,
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
const MANAGER: Address = '0x00000000000000000000000000000000000000a0';
// The mirror's MigrationAccountDeployer, which the accounts operator calls, and a contract that isn't it.
const DEPLOYER: Address = '0x00000000000000000000000000000000000de910';
const SAFE: Address = '0x000000000000000000000000000000000000005a';

// MigrationAccount's AccountInput as Solidity declares it, and MigrationAccountDeployer.applyBatch's payload.
const ACCOUNT_INPUT = parseAbiParameters(
  '(address owner, address proxyAdminOwner, string metadataURI, (address account, bool execute, bool transferTokens, bool setMetadata, uint32 allowanceKey)[] managers)'
);
const ACCOUNT_IMPORTS = parseAbiParameters(
  '(address source, (address owner, address proxyAdminOwner, string metadataURI, (address account, bool execute, bool transferTokens, bool setMetadata, uint32 allowanceKey)[] managers) account)[]'
);

type Manager = {
  account: Address;
  execute: boolean;
  transferTokens: boolean;
  setMetadata: boolean;
  allowanceKey: number;
};
type AccountState = { owner: Address; metadataURI: string; managers?: Manager[] };

const accountInput = (state: AccountState) => ({
  proxyAdminOwner: state.owner,
  managers: [] as Manager[],
  ...state,
});

/** What a MigrationAccount emits for the state it imports: keccak256(abi.encode(input)). */
const stateHash = (state: AccountState) =>
  keccak256(encodeAbiParameters(ACCOUNT_INPUT, [accountInput(state)]));

let transactions = 0;

/** A transaction calling `to` with MigrationAccountDeployer.applyBatch's calldata. */
function applyBatch(to: Address, payload: Hex) {
  transactions++;
  return {
    hash: keccak256(toHex(`transaction ${transactions}`)),
    to,
    input: encodeFunctionData({
      abi: migrationAccountDeployerAbi,
      functionName: 'applyBatch',
      args: [BigInt(transactions), 1n, payload],
    }),
  };
}

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
  const states = new Map<string, AccountState>();
  const reads: string[] = [];
  const context = {
    db,
    contracts: { MigrationAccountDeployer: { address: DEPLOYER } },
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
        return accountInput(state);
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
    /**
     * The accounts operator's applyBatch of these Accounts, a transaction to `to`: as the deployer does, each new one
     * is mapped (`source`), then emits AccountImported with the hash of the state it took.
     */
    async importAccounts(
      imports: { target: Address; state: AccountState; source?: Address }[],
      to: Address = DEPLOYER
    ) {
      const transaction = applyBatch(
        to,
        encodeAbiParameters(ACCOUNT_IMPORTS, [
          imports.map(({ target, state, source }) => ({
            source: source ?? target,
            account: accountInput(state),
          })),
        ])
      );
      for (const { target, state, source } of imports) {
        states.set(target.toLowerCase(), state);
        if (source) {
          await accountMapped(event({ source, target }), context);
        }
        await accountImported(
          { ...event({ revision: 1n, stateHash: stateHash(state) }, target), transaction },
          context
        );
      }
    },
    importAccount(target: Address, state: AccountState, source?: Address) {
      return this.importAccounts([{ target, state, source }]);
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
  it('imports an Account with its owner and inline profile, from its import’s transaction, and its Lens Chain address', async () => {
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
    expect(m.reads).toEqual([]);
    expect(m.rows(mirrorPendingAccount)).toEqual([]);
    expect(await m.status()).toMatchObject({ accounts: 1, accountReads: 0 });
  });

  it('takes each Account of a batch the state its hash proves', async () => {
    const m = mirror();
    const alice = { owner: OWNER, metadataURI: toDataURI(accountMetadata({ name: 'Alice' })) };
    const bob = {
      owner: NEW_OWNER,
      metadataURI: 'lens://bob',
      managers: [
        {
          account: MANAGER,
          execute: true,
          transferTokens: false,
          setMetadata: true,
          allowanceKey: 1,
        },
      ],
    };
    // As Solidity's abi.encode(input) hashes it (cast abi-encode), from the struct's offset (0x20) on.
    expect(stateHash(bob)).toBe(
      '0xc15b1900a01ecf4de9d82660892c3fa792e4a34b955e611610f65f9dcd4f981b'
    );
    await m.importAccounts([
      { target: ALICE, state: alice, source: LENS_ALICE },
      { target: BOB, state: bob },
      // The same state as Alice's: either item proves it.
      { target: CAROL, state: alice },
    ]);
    expect(await m.find(account, { address: ALICE })).toMatchObject({
      owner: OWNER,
      name: 'Alice',
    });
    expect(await m.find(account, { address: BOB })).toMatchObject({
      owner: NEW_OWNER,
      metadataUri: 'lens://bob',
    });
    expect(await m.find(account, { address: CAROL })).toMatchObject({
      owner: OWNER,
      name: 'Alice',
    });
    expect(m.reads).toEqual([]);
    expect(await m.status()).toMatchObject({ accounts: 3, accountReads: 0 });
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
    expect(m.reads).toEqual([]);
    expect((await m.status())?.accounts).toBe(1);
  });

  it('reads an Account whose transaction doesn’t prove its state, and counts the read', async () => {
    const m = mirror();
    // The operator's batch, sent through another contract.
    await m.importAccounts(
      [{ target: ALICE, state: { owner: OWNER, metadataURI: 'lens://alice' } }],
      SAFE
    );
    expect(await m.find(account, { address: ALICE })).toMatchObject({
      owner: OWNER,
      metadataUri: 'lens://alice',
    });
    expect(m.reads).toEqual([`readAccount@${ALICE}`]);
    // A later import that proves its state reads nothing.
    await m.importAccount(ALICE, { owner: NEW_OWNER, metadataURI: 'lens://alice' });
    expect(m.reads).toHaveLength(1);
    expect(await m.status()).toMatchObject({ accounts: 1, accountReads: 1 });
  });

  it('takes no state its transaction doesn’t prove', () => {
    const alice = { owner: OWNER, metadataURI: 'lens://alice' };
    const batch = (to: Address) =>
      applyBatch(
        to,
        encodeAbiParameters(ACCOUNT_IMPORTS, [
          [{ source: LENS_ALICE, account: accountInput(alice) }],
        ])
      );
    expect(importedState(batch(DEPLOYER), DEPLOYER, stateHash(alice))).toMatchObject({
      owner: getAddress(OWNER),
      metadataURI: 'lens://alice',
    });
    expect(importedState(batch(SAFE), DEPLOYER, stateHash(alice))).toBeNull();
    expect(
      importedState(batch(DEPLOYER), DEPLOYER, stateHash({ ...alice, owner: NEW_OWNER }))
    ).toBeNull();
    // A metadata URI that isn't UTF-8: the Account hashes its bytes, which a decoded string doesn't keep.
    const bytes = { ...accountInput(alice), metadataURI: '0x6c656e733a2f2fff' as Hex };
    const raw = applyBatch(
      DEPLOYER,
      encodeAbiParameters(
        parseAbiParameters(
          '(address source, (address owner, address proxyAdminOwner, bytes metadataURI, (address account, bool execute, bool transferTokens, bool setMetadata, uint32 allowanceKey)[] managers) account)[]'
        ),
        [[{ source: LENS_ALICE, account: bytes }]]
      )
    );
    const rawHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          '(address owner, address proxyAdminOwner, bytes metadataURI, (address account, bool execute, bool transferTokens, bool setMetadata, uint32 allowanceKey)[] managers)'
        ),
        [bytes]
      )
    );
    expect(importedState(raw, DEPLOYER, rawHash)).toBeNull();
    // Nor calldata that isn't applyBatch's.
    expect(
      importedState({ ...batch(DEPLOYER), input: '0xdeadbeef' }, DEPLOYER, stateHash(alice))
    ).toBeNull();
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
