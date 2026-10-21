import {
  migrationAccountAbi,
  parseDataURI,
  readPostMetadata,
  readProfile,
} from '@lens-monad/protocol';
import type { Context } from 'ponder:registry';
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
} from 'ponder:schema';
import { encodePacked, isAddressEqual, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import {
  addRecipient,
  notify,
  notifyPost,
  type NotificationType,
  type Position,
} from './notifications';
import { hashtagsOf } from './tokens';

// The handlers of the mirror's importer events (mirror.ts registers them), which write the tables the API reads, as
// the launch deployment's handlers do (index.ts).
//
// The importers set state rather than replay history: each record is a key's state on Lens Chain, and a later import
// of the same key is an update (an edit, a deletion, an unfollow, an unblock, a new owner or profile, a username
// moving). Records come in any order: Accounts first, then active Accounts' content, then the rest of history, newest
// first, with Lens Chain's new activity streaming throughout. So:
//
// - rows are ordered by their original time on Lens Chain, never by Monad's (see the positions below);
// - counts towards an Account or a post that isn't in yet wait in the pending tables, until it arrives;
// - only records from after the mirror's start notify: history doesn't.

type Block = { number: bigint; timestamp: bigint };
type ImportEvent<args> = { args: args; block: Block; log: { address: Address } };
type PostRow = typeof post.$inferSelect;
type CountedAccountField = 'followers' | 'following' | 'posts';
type CountedPostField = 'replies' | 'reposts' | 'quotes';

const STATUS = { id: 1 };

/** Positions' tiebreakers fit in the 9 digits cursors and notification ids give them. */
const TIEBREAKS = 1_000_000_000n;

/** A post's position: its creation time on Lens Chain, then its sequential id in the Lens Chain feed. */
export function postPosition(createdAt: bigint, postSequentialId: bigint): Position {
  return {
    blockNumber: createdAt,
    logIndex: Number(postSequentialId % TIEBREAKS),
    timestamp: createdAt,
  };
}

/** A follow's position: its time on Lens Chain, then a tiebreaker from the pair, the same at every import. */
export function followPosition(follower: Address, followed: Address, createdAt: bigint): Position {
  const pair = keccak256(encodePacked(['address', 'address'], [follower, followed]));
  return {
    blockNumber: createdAt,
    logIndex: Number(BigInt(pair) % TIEBREAKS),
    timestamp: createdAt,
  };
}

/** Addresses as Ponder stores them, so rows compare and key alike whatever the event's casing. */
function lower(address: Address): Address {
  return address.toLowerCase() as Address;
}

function orNull(address: Address): Address | null {
  return isAddressEqual(address, zeroAddress) ? null : lower(address);
}

// Status

/**
 * The mirror's status. The first import creates it, and its block time is the mirror's start: records from before it
 * are history, which never notifies.
 */
async function status(context: Context, at: Block) {
  return (
    (await context.db.find(mirrorStatus, STATUS)) ??
    (await context.db.insert(mirrorStatus).values({
      ...STATUS,
      notifySince: at.timestamp,
      accounts: 0,
      posts: 0,
      lensChainPosts: null,
      follows: 0,
      usernames: 0,
      blocks: 0,
      oldestPostAt: null,
      newestPostAt: null,
      lastImportBlock: at.number,
      lastImportAt: at.timestamp,
    }))
  );
}

type Status = Awaited<ReturnType<typeof status>>;

async function recordImport(
  context: Context,
  at: Block,
  change: (current: Status) => Partial<Status> = () => ({})
) {
  const current = await status(context, at);
  await context.db
    .update(mirrorStatus, STATUS)
    .set({ ...change(current), lastImportBlock: at.number, lastImportAt: at.timestamp });
}

/** Whether a record from `createdAt` is news rather than history. */
async function isNew(context: Context, at: Block, createdAt: bigint) {
  return createdAt >= (await status(context, at)).notifySince;
}

// What waits for Accounts and posts that aren't in yet

const NO_COUNTS = { followers: 0, following: 0, posts: 0, username: null, lensChainAddress: null };

async function countAccount(
  context: Context,
  address: Address,
  field: CountedAccountField,
  delta: 1 | -1
) {
  if (await context.db.find(account, { address })) {
    await context.db
      .update(account, { address })
      .set((row) => ({ [field]: Math.max(0, row[field] + delta) }));
    return;
  }
  await context.db
    .insert(mirrorPendingAccount)
    .values({ ...NO_COUNTS, address, [field]: delta })
    .onConflictDoUpdate((row) => ({ [field]: row[field] + delta }));
}

/** Counts towards the post, and returns it if it's in. */
async function countPost(
  context: Context,
  id: bigint | null,
  field: CountedPostField,
  delta: 1 | -1
): Promise<PostRow | undefined> {
  if (id === null) {
    return undefined;
  }
  const row = await context.db.find(post, { id });
  if (row) {
    await context.db
      .update(post, { id })
      .set((current) => ({ [field]: Math.max(0, current[field] + delta) }));
    return row;
  }
  await context.db
    .insert(mirrorPendingPost)
    .values({ id, replies: 0, reposts: 0, quotes: 0, [field]: delta })
    .onConflictDoUpdate((current) => ({ [field]: current[field] + delta }));
  return undefined;
}

/** A live post counts towards its author's posts, and its parents' replies, quotes and reposts. */
async function countLivePost(context: Context, row: PostRow, delta: 1 | -1) {
  await countAccount(context, row.author, 'posts', delta);
  return {
    replied: await countPost(context, row.repliedPostId, 'replies', delta),
    quoted: await countPost(context, row.quotedPostId, 'quotes', delta),
    reposted: await countPost(context, row.repostedPostId, 'reposts', delta),
  };
}

/** The username an Account holds, once in or still pending. */
async function heldUsername(context: Context, address: Address) {
  const row =
    (await context.db.find(account, { address })) ??
    (await context.db.find(mirrorPendingAccount, { address }));
  return row?.username ?? null;
}

async function holdUsername(context: Context, address: Address, name: string | null) {
  if (await context.db.find(account, { address })) {
    await context.db.update(account, { address }).set({ username: name });
  } else if (name !== null) {
    await context.db
      .insert(mirrorPendingAccount)
      .values({ ...NO_COUNTS, address, username: name })
      .onConflictDoUpdate({ username: name });
  } else if (await context.db.find(mirrorPendingAccount, { address })) {
    await context.db.update(mirrorPendingAccount, { address }).set({ username: null });
  }
}

// Accounts

/** MigrationAccountDeployer maps a Lens Chain Account to its Monad address, then imports it in the same transaction. */
export async function accountMapped(
  event: ImportEvent<{ source: Address; target: Address }>,
  context: Context
) {
  const address = lower(event.args.target);
  const lensChainAddress = lower(event.args.source);
  if (await context.db.find(account, { address })) {
    await context.db.update(account, { address }).set({ lensChainAddress });
  } else {
    await context.db
      .insert(mirrorPendingAccount)
      .values({ ...NO_COUNTS, address, lensChainAddress })
      .onConflictDoUpdate({ lensChainAddress });
  }
  await recordImport(context, event.block);
}

/**
 * An Account's import, its first or an update: its owner and profile are read from the Account, as the import left it
 * at the event's block (Ponder's default block, which lets it prefetch the reads).
 */
export async function accountImported(
  event: ImportEvent<{ revision: bigint; stateHash: Hex }>,
  context: Context
) {
  const address = lower(event.log.address);
  const state = await context.client.readContract({
    abi: migrationAccountAbi,
    address,
    functionName: 'readAccount',
  });
  const fields = {
    owner: lower(state.owner),
    metadataUri: state.metadataURI,
    ...readProfile(state.metadataURI),
  };
  if (await context.db.find(account, { address })) {
    await context.db.update(account, { address }).set(fields);
    await recordImport(context, event.block);
    return;
  }
  const pending = await context.db.find(mirrorPendingAccount, { address });
  await context.db.insert(account).values({
    address,
    ...fields,
    username: pending?.username ?? null,
    // Lens Chain's sponsors aren't Parallax's, and no one acts for a mirrored Account.
    sponsored: false,
    followers: Math.max(0, pending?.followers ?? 0),
    following: Math.max(0, pending?.following ?? 0),
    posts: Math.max(0, pending?.posts ?? 0),
    createdAt: event.block.timestamp,
    lensChainAddress: pending?.lensChainAddress ?? null,
  });
  if (pending) {
    await context.db.delete(mirrorPendingAccount, { address });
  }
  await recordImport(context, event.block, (current) => ({ accounts: current.accounts + 1 }));
}

// Usernames

/**
 * A username's state: its Account, or none once unassigned or burned. As the importer does, the name leaves the
 * Account that held it, and displaces the name its new Account held.
 */
export async function usernameImported(
  event: ImportEvent<{ username: { username: string; assignedAccount: Address } }>,
  context: Context
) {
  const name = event.args.username.username;
  const assigned = orNull(event.args.username.assignedAccount);
  const holder = await context.db.find(username, { username: name });
  let delta = 0;
  if (holder && holder.account !== assigned) {
    if ((await heldUsername(context, holder.account)) === name) {
      await holdUsername(context, holder.account, null);
    }
    await context.db.delete(username, { username: name });
    delta--;
  }
  if (assigned && holder?.account !== assigned) {
    const displaced = await heldUsername(context, assigned);
    if (displaced !== null && displaced !== name) {
      if ((await context.db.find(username, { username: displaced }))?.account === assigned) {
        await context.db.delete(username, { username: displaced });
        delta--;
      }
    }
    await context.db.insert(username).values({ username: name, account: assigned });
    await holdUsername(context, assigned, name);
    delta++;
  }
  await recordImport(context, event.block, (current) => ({
    usernames: current.usernames + delta,
  }));
}

// Posts

type ImportedPost = {
  author: Address;
  postSequentialId: bigint;
  contentURI: string;
  rootPostId: bigint;
  repostedPostId: bigint;
  quotedPostId: bigint;
  repliedPostId: bigint;
  creationTimestamp: bigint;
  lastUpdatedTimestamp: bigint;
  isDeleted: boolean;
};

async function addHashtags(context: Context, row: PostRow) {
  const tags = hashtagsOf(row.content);
  if (tags.length > 0) {
    await context.db
      .insert(hashtag)
      .values(
        tags.map((tag) => ({
          tag,
          postId: row.id,
          createdAt: row.createdAt,
          blockNumber: row.blockNumber,
          logIndex: row.logIndex,
        }))
      )
      .onConflictDoNothing();
  }
}

async function removeHashtags(context: Context, row: PostRow) {
  for (const tag of hashtagsOf(row.content)) {
    await context.db.delete(hashtag, {
      tag,
      blockNumber: row.blockNumber,
      logIndex: row.logIndex,
    });
  }
}

/**
 * A post's state. The first import adds it; later ones edit or delete it, as the importer never changes a post's
 * author, time or references. Only inline metadata is read here: the API reads offchain metadata when it serves posts.
 */
export async function postImported(
  event: ImportEvent<{ postId: bigint; post: ImportedPost; creationSource: Address }>,
  context: Context
) {
  const { postId: id, post: imported, creationSource } = event.args;
  const metadata = readPostMetadata(parseDataURI(imported.contentURI));
  const content = { contentUri: imported.contentURI, content: metadata?.content ?? null };
  const editedAt =
    imported.lastUpdatedTimestamp > imported.creationTimestamp
      ? imported.lastUpdatedTimestamp
      : null;
  const existing = await context.db.find(post, { id });

  if (existing) {
    if (existing.contentUri !== imported.contentURI) {
      await removeHashtags(context, existing);
      await context.db.update(post, { id }).set({ ...content, image: metadata?.image ?? null });
      if (!existing.deleted && !imported.isDeleted) {
        await addHashtags(context, { ...existing, ...content });
      }
    }
    await context.db.update(post, { id }).set({ editedAt, deleted: imported.isDeleted });
    if (existing.deleted !== imported.isDeleted) {
      await countLivePost(context, existing, imported.isDeleted ? -1 : 1);
    }
    await recordImport(context, event.block);
    return;
  }

  const position = postPosition(imported.creationTimestamp, imported.postSequentialId);
  const reference = (value: bigint) => (value === 0n ? null : value);
  const pending = await context.db.find(mirrorPendingPost, { id });
  const row: PostRow = {
    id,
    author: lower(imported.author),
    ...content,
    image: metadata?.image ?? null,
    rootPostId: imported.rootPostId,
    repliedPostId: reference(imported.repliedPostId),
    quotedPostId: reference(imported.quotedPostId),
    repostedPostId: reference(imported.repostedPostId),
    replies: Math.max(0, pending?.replies ?? 0),
    reposts: Math.max(0, pending?.reposts ?? 0),
    quotes: Math.max(0, pending?.quotes ?? 0),
    deleted: imported.isDeleted,
    source: orNull(creationSource),
    createdAt: imported.creationTimestamp,
    editedAt,
    blockNumber: position.blockNumber,
    logIndex: position.logIndex,
  };
  await context.db.insert(post).values(row);
  if (pending) {
    await context.db.delete(mirrorPendingPost, { id });
  }
  if (!row.deleted) {
    const references = await countLivePost(context, row, 1);
    await addHashtags(context, row);
    if (await isNew(context, event.block, row.createdAt)) {
      await notifyPost(context, position, row, references);
    }
  }
  await recordImport(context, event.block, (current) => ({
    posts: current.posts + 1,
    oldestPostAt:
      current.oldestPostAt === null || row.createdAt < current.oldestPostAt
        ? row.createdAt
        : current.oldestPostAt,
    newestPostAt:
      current.newestPostAt === null || row.createdAt > current.newestPostAt
        ? row.createdAt
        : current.newestPostAt,
  }));
}

/** The feed's counters come with every post batch: its post count is Lens Chain's. */
export async function feedCountersImported(
  event: ImportEvent<{ postCount: bigint }>,
  context: Context
) {
  await recordImport(context, event.block, () => ({ lensChainPosts: event.args.postCount }));
}

// Follows

/**
 * A follow's state. An inactive one is an unfollow; an active one under a new id is a new follow of the same pair,
 * which replaces the old one and its notification.
 */
export async function followImported(
  event: ImportEvent<{
    follower: Address;
    followed: Address;
    id: bigint;
    timestamp: bigint;
    active: boolean;
  }>,
  context: Context
) {
  const follower = lower(event.args.follower);
  const followed = lower(event.args.followed);
  const { id, timestamp, active } = event.args;
  const existing = await context.db.find(follow, { follower, followed });
  let delta = 0;
  if (existing && (!active || existing.followId !== id)) {
    await context.db.delete(follow, { follower, followed });
    // The follow notification is at the follow's position.
    await context.db.delete(notification, {
      recipient: followed,
      blockNumber: existing.blockNumber,
      logIndex: existing.logIndex,
    });
    await countAccount(context, follower, 'following', -1);
    await countAccount(context, followed, 'followers', -1);
    delta--;
  }
  if (active && existing?.followId !== id) {
    const position = followPosition(follower, followed, timestamp);
    await context.db.insert(follow).values({
      follower,
      followed,
      followId: id,
      createdAt: timestamp,
      blockNumber: position.blockNumber,
      logIndex: position.logIndex,
    });
    await countAccount(context, follower, 'following', 1);
    await countAccount(context, followed, 'followers', 1);
    delta++;
    if (await isNew(context, event.block, timestamp)) {
      const recipients = new Map<Address, NotificationType>();
      addRecipient(recipients, follower, followed, 'follow');
      await notify(context, position, follower, recipients, () => ({
        actorPostId: null,
        postId: null,
      }));
    }
  }
  await recordImport(context, event.block, (current) => ({ follows: current.follows + delta }));
}

// Blocks

/** A block, or with `blocked` false an unblock. Lens Chain's blocks carry no time: `createdAt` is the import's. */
export async function blockImported(
  event: ImportEvent<{ source: Address; target: Address; blocked: boolean }>,
  context: Context
) {
  const key = { blocker: lower(event.args.source), blocked: lower(event.args.target) };
  const existing = await context.db.find(block, key);
  let delta = 0;
  if (event.args.blocked && !existing) {
    await context.db.insert(block).values({ ...key, createdAt: event.block.timestamp });
    delta = 1;
  } else if (!event.args.blocked && existing) {
    await context.db.delete(block, key);
    delta = -1;
  }
  await recordImport(context, event.block, (current) => ({ blocks: current.blocks + delta }));
}
