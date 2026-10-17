import { index, onchainEnum, onchainTable, primaryKey } from 'ponder';

/** Lens Accounts created by the AccountFactory, with their profile and username in the global Namespace. */
export const account = onchainTable(
  'account',
  (t) => ({
    address: t.hex().primaryKey(),
    owner: t.hex().notNull(),
    metadataUri: t.text().notNull(),
    name: t.text(),
    bio: t.text(),
    picture: t.text(),
    username: t.text(),
    /** Whether SponsorRouter can execute transactions for the Account, so relayers can pay its gas. */
    sponsored: t.boolean().notNull(),
    followers: t.integer().notNull(),
    following: t.integer().notNull(),
    posts: t.integer().notNull(),
    createdAt: t.bigint().notNull(),
  }),
  (table) => ({
    ownerIndex: index().on(table.owner),
    usernameIndex: index().on(table.username),
    /** Suggested accounts: most followed first. */
    popularIndex: index().on(table.followers, table.createdAt),
  })
);

/**
 * Who holds each username of the global Namespace, Lens Account or not, to resolve @mentions with a primary key
 * lookup.
 */
export const username = onchainTable('username', (t) => ({
  username: t.text().primaryKey(),
  account: t.hex().notNull(),
}));

/** Posts of the global Feed. Monad timestamps are shared by several blocks, so posts are ordered by log position. */
export const post = onchainTable(
  'post',
  (t) => ({
    id: t.bigint().primaryKey(),
    author: t.hex().notNull(),
    contentUri: t.text().notNull(),
    /** The text of inline Lens metadata, null for other URIs and for reposts. */
    content: t.text(),
    rootPostId: t.bigint().notNull(),
    repliedPostId: t.bigint(),
    quotedPostId: t.bigint(),
    repostedPostId: t.bigint(),
    replies: t.integer().notNull(),
    reposts: t.integer().notNull(),
    quotes: t.integer().notNull(),
    /** Deleting only flags the post: its creation event, and so its content, stays public on-chain. */
    deleted: t.boolean().notNull(),
    source: t.hex(),
    createdAt: t.bigint().notNull(),
    editedAt: t.bigint(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
  }),
  (table) => ({
    orderIndex: index().on(table.blockNumber, table.logIndex),
    authorIndex: index().on(table.author, table.blockNumber, table.logIndex),
    /** A thread's replies, oldest first. */
    repliedIndex: index().on(table.repliedPostId, table.blockNumber, table.logIndex),
    /** The viewer's reposts of the posts on a page. */
    repostedIndex: index().on(table.repostedPostId, table.author),
  })
);

/**
 * The hashtags of posts, lowercase and without '#', at the post's position: a post is one log, so
 * (tag, blockNumber, logIndex) is unique and pages a hashtag's posts like the timelines.
 */
export const hashtag = onchainTable(
  'hashtag',
  (t) => ({
    tag: t.text().notNull(),
    postId: t.bigint().notNull(),
    createdAt: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.tag, table.blockNumber, table.logIndex] }),
    /** Trends: the hashtags of a recent time window. */
    recentIndex: index().on(table.createdAt),
  })
);

/** Ordered by the position of the Followed event, newest first in follower lists. */
export const follow = onchainTable(
  'follow',
  (t) => ({
    follower: t.hex().notNull(),
    followed: t.hex().notNull(),
    followId: t.bigint().notNull(),
    createdAt: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.follower, table.followed] }),
    followedIndex: index().on(table.followed, table.blockNumber, table.logIndex),
    followerIndex: index().on(table.follower, table.blockNumber, table.logIndex),
  })
);

/** AccountBlockingRule: `blocker` blocked `blocked`, who then can't reply to or follow them. */
export const block = onchainTable(
  'block',
  (t) => ({
    blocker: t.hex().notNull(),
    blocked: t.hex().notNull(),
    createdAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.blocker, table.blocked] }),
    blockedIndex: index().on(table.blocked),
  })
);

export const notificationType = onchainEnum('notification_type', [
  'follow',
  'reply',
  'repost',
  'quote',
  'mention',
]);

/**
 * What happened to `recipient`, at the position of the event that caused it. A log notifies each recipient at most
 * once, so (recipient, blockNumber, logIndex) is unique and pages like the timelines.
 */
export const notification = onchainTable(
  'notification',
  (t) => ({
    recipient: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    type: notificationType('type').notNull(),
    /** Whether it's in the Mentions tab: mentions and replies. */
    mentions: t.boolean().notNull(),
    actor: t.hex().notNull(),
    /** The actor's post: the reply, quote, mentioning post or repost. Null for follows. */
    actorPostId: t.bigint(),
    /** The post shown: the actor's post, or for reposts the recipient's reposted post. Null for follows. */
    postId: t.bigint(),
    createdAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.recipient, table.blockNumber, table.logIndex] }),
    mentionsIndex: index().on(table.recipient, table.mentions, table.blockNumber, table.logIndex),
  })
);
