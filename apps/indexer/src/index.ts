import {
  getDeployment,
  MAX_MEDIA_BYTES,
  readPostContent,
  readPostImage,
  readProfile,
} from '@lens-monad/protocol';
import { ponder, type Context } from 'ponder:registry';
import {
  account,
  block,
  follow,
  hashtag,
  mediaChunk,
  notification,
  post,
  username,
} from 'ponder:schema';
import { hexToBytes, isAddressEqual, zeroAddress, type Address } from 'viem';
import { hashtagsOf, mentionedUsernames } from './tokens';

const { contracts } = getDeployment(Number(process.env.PONDER_CHAIN_ID ?? 31337));

type CountedAccountField = 'followers' | 'following' | 'posts';
type CountedPostField = 'replies' | 'reposts' | 'quotes';
type PostRow = typeof post.$inferSelect;
type NotificationRow = typeof notification.$inferInsert;
type NotificationType = NotificationRow['type'];
/** Where a notification happened: the event's block and log. */
type Position = { blockNumber: bigint; logIndex: number; timestamp: bigint };

function positionOf(event: {
  block: { number: bigint; timestamp: bigint };
  log: { logIndex: number };
}) {
  return {
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
  };
}

// Graph and Feed calls can come from any address, not only Accounts this indexer tracks: counters skip unknown ones.
async function bumpAccount(
  context: Context,
  address: Address,
  field: CountedAccountField,
  delta: 1 | -1
) {
  if (await context.db.find(account, { address })) {
    await context.db
      .update(account, { address })
      .set((row) => ({ [field]: Math.max(0, row[field] + delta) }));
  }
}

/** Bumps a counter of the post, and returns the post as it was. */
async function bumpPost(
  context: Context,
  id: bigint | null,
  field: CountedPostField,
  delta: 1 | -1
): Promise<PostRow | undefined> {
  const row = id ? await context.db.find(post, { id }) : null;
  if (row) {
    await context.db
      .update(post, { id: row.id })
      .set((current) => ({ [field]: Math.max(0, current[field] + delta) }));
  }
  return row ?? undefined;
}

/** A log notifies each recipient at most once, so its position identifies the notification for that recipient. */
async function notify(
  context: Context,
  position: Position,
  actor: Address,
  recipients: Map<Address, NotificationType>,
  posts: (type: NotificationType) => Pick<NotificationRow, 'actorPostId' | 'postId'>
) {
  if (recipients.size === 0) {
    return;
  }
  await context.db
    .insert(notification)
    .values(
      [...recipients].map(([recipient, type]) => ({
        recipient,
        blockNumber: position.blockNumber,
        logIndex: position.logIndex,
        type,
        mentions: type === 'reply' || type === 'mention',
        actor,
        ...posts(type),
        createdAt: position.timestamp,
      }))
    )
    .onConflictDoNothing();
}

/** Never notifies the actor, and keeps the first type given to a recipient. */
function addRecipient(
  recipients: Map<Address, NotificationType>,
  actor: Address,
  recipient: Address | undefined,
  type: NotificationType
) {
  const key = recipient?.toLowerCase() as Address | undefined;
  if (key && !isAddressEqual(key, actor) && !recipients.has(key)) {
    recipients.set(key, type);
  }
}

// Accounts

ponder.on('AccountFactory:Lens_Account_Created', async ({ event, context }) => {
  const {
    account: address,
    owner,
    metadataURI,
    accountManagers,
    accountManagersPermissions,
  } = event.args;
  const routerIndex = accountManagers.findIndex((manager) =>
    isAddressEqual(manager, contracts.SponsorRouter)
  );
  await context.db.insert(account).values({
    address,
    owner,
    metadataUri: metadataURI,
    ...readProfile(metadataURI),
    username: null,
    sponsored: routerIndex >= 0 && accountManagersPermissions[routerIndex]!.canExecuteTransactions,
    followers: 0,
    following: 0,
    posts: 0,
    createdAt: event.block.timestamp,
  });
});

// LensFactory creates Accounts as their owner, then hands them over.
ponder.on('Account:Lens_Account_OwnershipTransferred', async ({ event, context }) => {
  const address = event.log.address;
  if (await context.db.find(account, { address })) {
    await context.db.update(account, { address }).set({ owner: event.args.newOwner });
  }
});

ponder.on(
  'Account:Lens_Account_MetadataURISet(string metadataURI, address indexed source)',
  async ({ event, context }) => {
    const address = event.log.address;
    if (await context.db.find(account, { address })) {
      await context.db
        .update(account, { address })
        .set({ metadataUri: event.args.metadataURI, ...readProfile(event.args.metadataURI) });
    }
  }
);

async function setSponsored(
  context: Context,
  address: Address,
  manager: Address,
  sponsored: boolean
) {
  if (
    isAddressEqual(manager, contracts.SponsorRouter) &&
    (await context.db.find(account, { address }))
  ) {
    await context.db.update(account, { address }).set({ sponsored });
  }
}

ponder.on('Account:Lens_Account_AccountManagerAdded', async ({ event, context }) => {
  await setSponsored(
    context,
    event.log.address,
    event.args.accountManager,
    event.args.permissions.canExecuteTransactions
  );
});

ponder.on('Account:Lens_Account_AccountManagerUpdated', async ({ event, context }) => {
  await setSponsored(
    context,
    event.log.address,
    event.args.accountManager,
    event.args.permissions.canExecuteTransactions
  );
});

ponder.on('Account:Lens_Account_AccountManagerRemoved', async ({ event, context }) => {
  await setSponsored(context, event.log.address, event.args.accountManager, false);
});

// Usernames in the global Namespace. A username is unassigned before it's assigned again, and an Account holds one.

ponder.on('Namespace:Lens_Username_Assigned', async ({ event, context }) => {
  const { username: name, account: address } = event.args;
  await context.db
    .insert(username)
    .values({ username: name, account: address })
    .onConflictDoUpdate({ account: address });
  if (await context.db.find(account, { address })) {
    await context.db.update(account, { address }).set({ username: name });
  }
});

ponder.on('Namespace:Lens_Username_Unassigned', async ({ event, context }) => {
  const { username: name, previousAccount: address } = event.args;
  const holder = await context.db.find(username, { username: name });
  if (holder && isAddressEqual(holder.account, address)) {
    await context.db.delete(username, { username: name });
  }
  const row = await context.db.find(account, { address });
  if (row?.username === name) {
    await context.db.update(account, { address }).set({ username: null });
  }
});

// Posts

/**
 * Notifies the authors of the reposted, replied and quoted posts, then the accounts the content mentions: a recipient
 * gets one notification per post, a reply rather than a mention.
 */
async function notifyPost(
  context: Context,
  position: Position,
  created: Pick<PostRow, 'id' | 'author' | 'content' | 'repostedPostId'>,
  references: { reposted?: PostRow; replied?: PostRow; quoted?: PostRow }
) {
  const recipients = new Map<Address, NotificationType>();
  addRecipient(recipients, created.author, references.reposted?.author, 'repost');
  addRecipient(recipients, created.author, references.replied?.author, 'reply');
  addRecipient(recipients, created.author, references.quoted?.author, 'quote');
  const holders = await Promise.all(
    mentionedUsernames(created.content).map((name) => context.db.find(username, { username: name }))
  );
  for (const holder of holders) {
    addRecipient(recipients, created.author, holder?.account, 'mention');
  }
  await notify(context, position, created.author, recipients, (type) => ({
    actorPostId: created.id,
    postId: type === 'repost' ? created.repostedPostId : created.id,
  }));
}

ponder.on('Feed:Lens_Feed_PostCreated', async ({ event, context }) => {
  const { postId, author, rootPostId, postParams, source } = event.args;
  const repliedPostId = postParams.repliedPostId || null;
  const quotedPostId = postParams.quotedPostId || null;
  const repostedPostId = postParams.repostedPostId || null;
  const content = readPostContent(postParams.contentURI);
  await context.db.insert(post).values({
    id: postId,
    author,
    contentUri: postParams.contentURI,
    content,
    image: readPostImage(postParams.contentURI),
    rootPostId,
    repliedPostId,
    quotedPostId,
    repostedPostId,
    replies: 0,
    reposts: 0,
    quotes: 0,
    deleted: false,
    source: isAddressEqual(source, zeroAddress) ? null : source,
    createdAt: event.block.timestamp,
    editedAt: null,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
  });
  await bumpAccount(context, author, 'posts', 1);
  const references = {
    replied: await bumpPost(context, repliedPostId, 'replies', 1),
    quoted: await bumpPost(context, quotedPostId, 'quotes', 1),
    reposted: await bumpPost(context, repostedPostId, 'reposts', 1),
  };
  await notifyPost(
    context,
    positionOf(event),
    { id: postId, author, content, repostedPostId },
    references
  );
  const tags = hashtagsOf(content);
  if (tags.length > 0) {
    await context.db
      .insert(hashtag)
      .values(
        tags.map((tag) => ({
          tag,
          postId,
          createdAt: event.block.timestamp,
          blockNumber: event.block.number,
          logIndex: event.log.logIndex,
        }))
      )
      .onConflictDoNothing();
  }
});

// Mentions and hashtags are indexed when the post is created, not when it's edited (the app doesn't edit posts).
ponder.on('Feed:Lens_Feed_PostEdited', async ({ event, context }) => {
  const id = event.args.postId;
  if (await context.db.find(post, { id })) {
    const contentUri = event.args.newPostParams.contentURI;
    await context.db.update(post, { id }).set({
      contentUri,
      content: readPostContent(contentUri),
      image: readPostImage(contentUri),
      editedAt: event.block.timestamp,
    });
  }
});

// The API hides the notifications about deleted posts, so deleting doesn't need to find them.
ponder.on('Feed:Lens_Feed_PostDeleted', async ({ event, context }) => {
  const id = event.args.postId;
  const row = await context.db.find(post, { id });
  if (!row || row.deleted) {
    return;
  }
  await context.db.update(post, { id }).set({ deleted: true });
  await bumpAccount(context, row.author, 'posts', -1);
  await bumpPost(context, row.repliedPostId, 'replies', -1);
  await bumpPost(context, row.quotedPostId, 'quotes', -1);
  await bumpPost(context, row.repostedPostId, 'reposts', -1);
});

// Media

// Only the author writes their media, so the first chunk at an offset stands: a retry resends the same bytes. Chunks
// past MAX_MEDIA_BYTES are dropped, so no one fills the database however much they pay.
ponder.on('MediaStore:MediaChunk', async ({ event, context }) => {
  const { author, id, offset, data } = event.args;
  const bytes = hexToBytes(data);
  if (bytes.length === 0 || offset + BigInt(bytes.length) > BigInt(MAX_MEDIA_BYTES)) {
    return;
  }
  await context.db
    .insert(mediaChunk)
    .values({ author, id, offset: Number(offset), data: bytes })
    .onConflictDoNothing();
});

// Follows

ponder.on('Graph:Lens_Graph_Followed', async ({ event, context }) => {
  const { followerAccount, accountToFollow, followId } = event.args;
  await context.db.insert(follow).values({
    follower: followerAccount,
    followed: accountToFollow,
    followId,
    createdAt: event.block.timestamp,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
  });
  await bumpAccount(context, followerAccount, 'following', 1);
  await bumpAccount(context, accountToFollow, 'followers', 1);
  const recipients = new Map<Address, NotificationType>();
  addRecipient(recipients, followerAccount, accountToFollow, 'follow');
  await notify(context, positionOf(event), followerAccount, recipients, () => ({
    actorPostId: null,
    postId: null,
  }));
});

ponder.on('Graph:Lens_Graph_Unfollowed', async ({ event, context }) => {
  const { followerAccount, accountToUnfollow } = event.args;
  const row = await context.db.find(follow, {
    follower: followerAccount,
    followed: accountToUnfollow,
  });
  if (!row) {
    return;
  }
  await context.db.delete(follow, { follower: followerAccount, followed: accountToUnfollow });
  // The follow notification is at the Followed event's position.
  await context.db.delete(notification, {
    recipient: row.followed,
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
  });
  await bumpAccount(context, followerAccount, 'following', -1);
  await bumpAccount(context, accountToUnfollow, 'followers', -1);
});

// Blocks

ponder.on('AccountBlockingRule:Lens_AccountBlocking_AccountBlocked', async ({ event, context }) => {
  await context.db
    .insert(block)
    .values({
      blocker: event.args.source,
      blocked: event.args.target,
      createdAt: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on(
  'AccountBlockingRule:Lens_AccountBlocking_AccountUnblocked',
  async ({ event, context }) => {
    await context.db.delete(block, { blocker: event.args.source, blocked: event.args.target });
  }
);
