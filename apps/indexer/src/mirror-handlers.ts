import {
  migrationAccountAbi,
  migrationAccountDeployerAbi,
  parseDataURI,
  readPostMetadata,
  readProfile,
  type PostImage,
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
  type PendingNotification,
} from 'ponder:schema';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  getAbiItem,
  isAddressEqual,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
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
// - counts towards an Account or a post that isn't in yet wait in the pending tables, until it arrives, and so do the
//   notifications its author is due;
// - only records from after the mirror's start notify: history doesn't.
//
// Lens Chain's records are anyone's: their text never goes to Postgres with NUL characters, which it refuses.

type Block = { number: bigint; timestamp: bigint };
type ImportEvent<args> = { args: args; block: Block; log: { address: Address } };
type Transaction = { hash: Hex; to: Address | null; input: Hex };
type PostRow = typeof post.$inferSelect;
type PendingPostRow = typeof mirrorPendingPost.$inferSelect;
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

/** A post waits for at most this many notifications of its author. */
const MAX_PENDING_NOTIFICATIONS = 100;

/** Text Postgres takes: without NUL characters. */
function clean<T extends string | null>(text: T): T {
  return (text === null ? null : text.replaceAll('\u0000', '')) as T;
}

function cleanImage(image: PostImage | null): PostImage | null {
  return (
    image && { ...image, item: clean(image.item), type: clean(image.type), alt: clean(image.alt) }
  );
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
      accountReads: 0,
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

/** The state an Account import sets, MigrationAccount's AccountInput, as readAccount returns it. */
const ACCOUNT_INPUT = getAbiItem({ abi: migrationAccountAbi, name: 'readAccount' }).outputs;

/** MigrationAccountDeployer.applyBatch's payload: abi.encode(AccountImport[]), an AccountImport being (source, account). */
const ACCOUNT_IMPORTS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'source', type: 'address' },
      { ...ACCOUNT_INPUT[0], name: 'account' },
    ],
  },
] as const;

type AccountInput = { owner: Address; metadataURI: string };

/** The states in the latest transaction decoded, by their hash: a transaction imports up to 10 Accounts. */
let decoded: { transaction: Hex; states: Map<Hex, AccountInput> } | undefined;

/**
 * The state an Account import set, from the transaction that made it, or null if the transaction doesn't say. The
 * accounts operator calls MigrationAccountDeployer.applyBatch(sequence, revision, abi.encode(AccountImport[])), which
 * imports each item's AccountInput into its Account; the Account emits AccountImported with the hash of what it took,
 * keccak256(abi.encode(input)). The item whose input hashes to the event's stateHash is the state, proven by the hash.
 * The deployer and the Account re-encode what they decode, so the input is hashed as the ABI encodes it, which for a
 * struct with dynamic fields starts with its offset (0x20).
 */
export function importedState(
  transaction: Transaction,
  deployer: Address,
  stateHash: Hex
): AccountInput | null {
  if (transaction.to === null || !isAddressEqual(transaction.to, deployer)) {
    return null;
  }
  if (decoded?.transaction !== transaction.hash) {
    const states = new Map<Hex, AccountInput>();
    try {
      const call = decodeFunctionData({
        abi: migrationAccountDeployerAbi,
        data: transaction.input,
      });
      if (call.functionName === 'applyBatch') {
        const [items] = decodeAbiParameters(ACCOUNT_IMPORTS, call.args[2]);
        for (const { account: input } of items) {
          states.set(keccak256(encodeAbiParameters(ACCOUNT_INPUT, [input])), input);
        }
      }
    } catch {
      // Not a batch this indexer can read: the Account is.
    }
    decoded = { transaction: transaction.hash, states };
  }
  return decoded.states.get(stateHash.toLowerCase() as Hex) ?? null;
}

/**
 * An Account's import, its first or an update: its owner and profile are the state it set, from the import's
 * transaction (importedState). Only if that doesn't prove it are they read from the Account, as the import left it at
 * the event's block, which needs an RPC that still has that block's state: the mirror's status counts those reads.
 */
export async function accountImported(
  event: ImportEvent<{ revision: bigint; stateHash: Hex }> & { transaction: Transaction },
  context: Context
) {
  const address = lower(event.log.address);
  const imported = importedState(
    event.transaction,
    context.contracts.MigrationAccountDeployer.address,
    event.args.stateHash
  );
  const state =
    imported ??
    (await context.client.readContract({
      abi: migrationAccountAbi,
      address,
      functionName: 'readAccount',
    }));
  const reads = imported ? 0 : 1;
  const profile = readProfile(state.metadataURI);
  const fields = {
    owner: lower(state.owner),
    metadataUri: clean(state.metadataURI),
    name: clean(profile.name),
    bio: clean(profile.bio),
    picture: clean(profile.picture),
  };
  if (await context.db.find(account, { address })) {
    await context.db.update(account, { address }).set(fields);
    await recordImport(context, event.block, (current) => ({
      accountReads: current.accountReads + reads,
    }));
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
  await recordImport(context, event.block, (current) => ({
    accounts: current.accounts + 1,
    accountReads: current.accountReads + reads,
  }));
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
  const name = clean(event.args.username.username);
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

const NOTIFICATION_RANKS: Record<NotificationType, number> = {
  repost: 0,
  reply: 1,
  quote: 2,
  mention: 3,
  follow: 4,
};

/** New replies, quotes and reposts of posts that aren't in yet: their authors are notified when they arrive. */
async function notifyLater(
  context: Context,
  created: PostRow,
  position: Position,
  references: Awaited<ReturnType<typeof countLivePost>>
) {
  const parents = [
    [created.repostedPostId, references.reposted, 'repost'],
    [created.repliedPostId, references.replied, 'reply'],
    [created.quotedPostId, references.quoted, 'quote'],
  ] as const;
  for (const [id, parent, type] of parents) {
    if (id === null || parent) {
      continue;
    }
    const due: PendingNotification = {
      type,
      actor: created.author,
      actorPostId: created.id.toString(),
      blockNumber: position.blockNumber.toString(),
      logIndex: position.logIndex,
      createdAt: position.timestamp.toString(),
    };
    // countPost made the post's pending row.
    await context.db.update(mirrorPendingPost, { id }).set((row) => ({
      notifications: [...(row.notifications ?? []), due].slice(-MAX_PENDING_NOTIFICATIONS),
    }));
  }
}

/**
 * The notifications a post's author was due while it wasn't in. Where the same post also mentioned them, the reply,
 * quote or repost wins, as when the post is in first (notifyPost).
 */
async function notifyDue(context: Context, row: PostRow, pending: PendingPostRow) {
  for (const due of pending.notifications ?? []) {
    if (due.actor === row.author) {
      continue;
    }
    const actorPostId = BigInt(due.actorPostId);
    const outranks = {
      type: due.type,
      mentions: due.type === 'reply',
      postId: due.type === 'repost' ? row.id : actorPostId,
    };
    await context.db
      .insert(notification)
      .values({
        ...outranks,
        recipient: row.author,
        blockNumber: BigInt(due.blockNumber),
        logIndex: due.logIndex,
        actor: due.actor,
        actorPostId,
        createdAt: BigInt(due.createdAt),
      })
      .onConflictDoUpdate((existing) =>
        NOTIFICATION_RANKS[due.type] < NOTIFICATION_RANKS[existing.type] ? outranks : {}
      );
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
  const content = {
    contentUri: clean(imported.contentURI),
    content: clean(metadata?.content ?? null),
  };
  const image = cleanImage(metadata?.image ?? null);
  const editedAt =
    imported.lastUpdatedTimestamp > imported.creationTimestamp
      ? imported.lastUpdatedTimestamp
      : null;
  const existing = await context.db.find(post, { id });

  if (existing) {
    if (existing.contentUri !== content.contentUri) {
      await removeHashtags(context, existing);
      await context.db.update(post, { id }).set({ ...content, image });
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
    image,
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
    await notifyDue(context, row, pending);
    await context.db.delete(mirrorPendingPost, { id });
  }
  if (!row.deleted) {
    const references = await countLivePost(context, row, 1);
    await addHashtags(context, row);
    if (await isNew(context, event.block, row.createdAt)) {
      await notifyPost(context, position, row, references);
      await notifyLater(context, row, position, references);
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
