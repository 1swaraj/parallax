import {
  MEDIA_STORE_ADDRESS,
  mediaId,
  mediaPath,
  sniffImageType,
  type AccountView,
  type ImageView,
  type NotificationView,
  type Page,
  type PostView,
  type ProfileView,
  type Relationship,
  type ThreadView,
  type TrendView,
} from '@lens-monad/protocol';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  alias,
  and,
  asc,
  count,
  desc,
  eq,
  graphql,
  gte,
  ilike,
  inArray,
  isNull,
  ne,
  notExists,
  notInArray,
  or,
  replaceBigInts,
  sql,
  type AnyPgColumn,
} from 'ponder';
import { db } from 'ponder:api';
import schema, {
  account,
  block,
  follow,
  hashtag,
  mediaChunk,
  notification,
  post,
} from 'ponder:schema';
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';

type AccountRow = typeof account.$inferSelect;
type PostRow = typeof post.$inferSelect;
type Condition = ReturnType<typeof and>;
/** A position in the chain, where pages and notifications are ordered: newest first. */
type Position = { blockNumber: bigint; logIndex: number };

const MAX_LIMIT = 100;
const MAX_ANCESTORS = 10;
const MAX_REPLIES = 100;
const MAX_UNREAD = 100;
const MAX_SEARCH_LENGTH = 100;
const MAX_LISTED_AUTHORS = 1000;
const MAX_TREND_HOURS = 7 * 24;
/** Trends count the hashtags of at most this many of the window's most recent posts. */
const MAX_TREND_SCAN = 50_000;

const CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 31337);

/** Media ids /media won't serve (MEDIA_BLOCKLIST, comma-separated): they stay on-chain, but not on the app. */
const MEDIA_BLOCKLIST = new Set(
  (process.env.MEDIA_BLOCKLIST ?? '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
);

const app = new Hono();

// Ponder serves /status (indexed block) and /ready itself. GraphQL is there for exploring the data, off unless
// ENABLE_GRAPHQL=true: its queries aren't bounded like this API's.
if (process.env.ENABLE_GRAPHQL === 'true') {
  app.use('/graphql', graphql({ db, schema }));
}

// Errors are JSON `{ error }`. Unexpected ones are logged, without leaking their details to clients.
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  console.error(`${c.req.method} ${c.req.path} failed`, error);
  return c.json({ error: 'Internal error' }, 500);
});

function badRequest(message: string) {
  return new HTTPException(400, { message });
}

function json<T>(value: T) {
  return replaceBigInts(value, (v) => v.toString());
}

function limitOf(raw: string | undefined, fallback = 20) {
  const limit = Number(raw ?? fallback);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : fallback;
}

// Ponder stores addresses lowercase, so queries compare lowercase addresses, and responses checksum them.
function addressParam(raw: string | undefined, name: string): Address | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  if (!isAddress(raw, { strict: false })) {
    throw badRequest(`Invalid ${name}`);
  }
  return raw.toLowerCase() as Address;
}

function requiredAddressParam(raw: string | undefined, name: string): Address {
  const address = addressParam(raw, name);
  if (!address) {
    throw badRequest(`${name} is required`);
  }
  return address;
}

// Cursors are the position of the last item of a page: `<blockNumber>:<logIndex>`.
function positionParam(raw: string | undefined, name = 'cursor'): Position | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  const match = /^(\d{1,20}):(\d{1,9})$/.exec(raw);
  if (!match) {
    throw badRequest(`Invalid ${name}`);
  }
  return { blockNumber: BigInt(match[1]!), logIndex: Number(match[2]) };
}

/** Rows before (older) or after (newer) a position, as a row comparison Postgres uses as an index bound. */
function relativeTo(
  table: { blockNumber: AnyPgColumn; logIndex: AnyPgColumn },
  direction: 'before' | 'after',
  position: Position | null
): Condition {
  if (!position) {
    return undefined;
  }
  const operator = sql.raw(direction === 'before' ? '<' : '>');
  return sql`(${table.blockNumber}, ${table.logIndex}) ${operator} (${sql.param(position.blockNumber, table.blockNumber)}, ${position.logIndex})`;
}

function nextCursor(rows: Position[], limit: number) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? `${last.blockNumber}:${last.logIndex}` : null;
}

function toAccountView(row: AccountRow): AccountView {
  return {
    address: getAddress(row.address),
    owner: getAddress(row.owner),
    username: row.username,
    name: row.name,
    bio: row.bio,
    picture: row.picture,
    sponsored: row.sponsored,
    followers: row.followers,
    following: row.following,
    posts: row.posts,
    createdAt: row.createdAt.toString(),
  };
}

/**
 * Images in this chain's MediaStore are served by /media, through the app's origin. Others only when their metadata
 * points at an https URL: the browser loads them from there.
 */
function toImageView(image: PostRow['image']): ImageView | null {
  if (!image) {
    return null;
  }
  const { locator } = image;
  const url =
    locator && locator.chainId === CHAIN_ID && isAddressEqual(locator.store, MEDIA_STORE_ADDRESS)
      ? mediaPath(locator.author, locator.id)
      : image.item.startsWith('https://')
        ? image.item
        : null;
  return url
    ? { url, type: image.type, alt: image.alt, width: image.width, height: image.height }
    : null;
}

/** A placeholder for authors the indexer doesn't track, e.g. EOAs posting directly. */
function unknownAccount(address: Address): AccountView {
  return {
    address: getAddress(address),
    owner: getAddress(address),
    username: null,
    name: null,
    bio: null,
    picture: null,
    sponsored: false,
    followers: 0,
    following: 0,
    posts: 0,
    createdAt: '0',
  };
}

async function accountsByAddress(addresses: Address[]) {
  const unique = [...new Set(addresses)];
  const rows = unique.length
    ? await db.select().from(account).where(inArray(account.address, unique))
    : [];
  const views = new Map(rows.map((row) => [row.address, toAccountView(row)]));
  return (address: Address) => views.get(address) ?? unknownAccount(address);
}

/** Who the viewer blocked. */
function blockedBy(viewer: Address) {
  return db.select({ blocked: block.blocked }).from(block).where(eq(block.blocker, viewer));
}

/** Who blocked the viewer. */
function blockersOf(viewer: Address) {
  return db.select({ blocker: block.blocker }).from(block).where(eq(block.blocked, viewer));
}

/** Who the viewer follows. */
function followedBy(viewer: Address) {
  return db.select({ followed: follow.followed }).from(follow).where(eq(follow.follower, viewer));
}

/** The post a view is about: the reposted post for reposts, the post itself otherwise. */
function shownPostId(row: PostRow) {
  return row.repostedPostId ?? row.id;
}

/** The viewer's live reposts of these posts, by reposted post id. The newest wins if there are several. */
async function viewerReposts(viewer: Address | null, ids: bigint[]) {
  const unique = [...new Set(ids)];
  const rows =
    viewer && unique.length
      ? await db
          .select({ id: post.id, repostedPostId: post.repostedPostId })
          .from(post)
          .where(
            and(
              inArray(post.repostedPostId, unique),
              eq(post.author, viewer),
              eq(post.deleted, false)
            )
          )
          .orderBy(asc(post.blockNumber), asc(post.logIndex))
      : [];
  return new Map(rows.map((row) => [row.repostedPostId!, row.id.toString()]));
}

/** Adds the authors, the quoted, reposted and replied-to posts (one level deep), and the viewer's reposts. */
async function hydrate(rows: PostRow[], viewer: Address | null): Promise<PostView[]> {
  const referencedIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.quotedPostId, row.repostedPostId, row.repliedPostId])
        .filter((id) => id !== null)
    ),
  ];
  const referenced = referencedIds.length
    ? await db.select().from(post).where(inArray(post.id, referencedIds))
    : [];
  const referencedById = new Map(referenced.map((row) => [row.id, row]));
  const [authorOf, reposts] = await Promise.all([
    accountsByAddress([...rows, ...referenced].map((row) => row.author)),
    viewerReposts(viewer, [...rows, ...referenced].map(shownPostId)),
  ]);

  const view = (row: PostRow, depth: number): PostView => {
    const nested = (id: bigint | null) => {
      const target = id === null || depth > 0 ? undefined : referencedById.get(id);
      return target ? view(target, depth + 1) : null;
    };
    const repliedTo =
      row.repliedPostId === null ? undefined : referencedById.get(row.repliedPostId);
    return {
      ...(json({
        id: row.id,
        contentUri: row.deleted ? '' : row.contentUri,
        content: row.deleted ? null : row.content,
        rootPostId: row.rootPostId,
        repliedPostId: row.repliedPostId,
        quotedPostId: row.quotedPostId,
        repostedPostId: row.repostedPostId,
        replies: row.replies,
        reposts: row.reposts,
        quotes: row.quotes,
        deleted: row.deleted,
        createdAt: row.createdAt,
        editedAt: row.editedAt,
      }) as Omit<PostView, 'author' | 'quoted' | 'reposted' | 'repliedTo' | 'viewerRepostId'>),
      author: authorOf(row.author),
      image: row.deleted ? null : toImageView(row.image),
      quoted: nested(row.quotedPostId),
      reposted: nested(row.repostedPostId),
      repliedTo: repliedTo
        ? { id: repliedTo.id.toString(), author: authorOf(repliedTo.author) }
        : null,
      viewerRepostId: reposts.get(shownPostId(row)) ?? null,
    };
  };
  return rows.map((row) => view(row, 0));
}

const repostedPost = alias(post, 'reposted_post');

/** Hides reposts of deleted posts, and of authors the viewer blocked. */
function visibleRepost(viewer: Address | null) {
  return or(
    isNull(post.repostedPostId),
    notExists(
      db
        .select({ id: repostedPost.id })
        .from(repostedPost)
        .where(
          and(
            eq(repostedPost.id, post.repostedPostId),
            or(
              eq(repostedPost.deleted, true),
              viewer ? inArray(repostedPost.author, blockedBy(viewer)) : undefined
            )
          )
        )
    )
  );
}

function notBlockedBy(viewer: Address | null) {
  return viewer ? notInArray(post.author, blockedBy(viewer)) : undefined;
}

/** Live posts, newest first. */
async function postsPage(
  conditions: Condition[],
  limit: number,
  viewer: Address | null
): Promise<Page<PostView>> {
  const rows = await db
    .select()
    .from(post)
    .where(and(eq(post.deleted, false), visibleRepost(viewer), ...conditions))
    .orderBy(desc(post.blockNumber), desc(post.logIndex))
    .limit(limit + 1);
  return pageOf(rows, limit, viewer);
}

/** A page of up to `limit` rows, from `limit + 1` fetched to know whether there's a next one. */
async function pageOf(rows: PostRow[], limit: number, viewer: Address | null) {
  return { items: await hydrate(rows.slice(0, limit), viewer), next: nextCursor(rows, limit) };
}

async function postViewsById(ids: bigint[], viewer: Address | null) {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db.select().from(post).where(inArray(post.id, unique)) : [];
  const views = await hydrate(rows, viewer);
  return new Map(views.map((view) => [view.id, view]));
}

async function findAccount(handle: string) {
  const [row] = await db
    .select()
    .from(account)
    .where(
      isAddress(handle, { strict: false })
        ? eq(account.address, handle.toLowerCase() as Address)
        : eq(account.username, handle.toLowerCase())
    )
    .limit(1);
  return row;
}

/** How the viewer relates to each target, in four queries whatever the number of targets. */
async function relationships(viewer: Address, targets: Address[]) {
  const [following, followedByTarget, blocking, blockedByTarget] = targets.length
    ? await Promise.all([
        db
          .select({ address: follow.followed })
          .from(follow)
          .where(and(eq(follow.follower, viewer), inArray(follow.followed, targets))),
        db
          .select({ address: follow.follower })
          .from(follow)
          .where(and(eq(follow.followed, viewer), inArray(follow.follower, targets))),
        db
          .select({ address: block.blocked })
          .from(block)
          .where(and(eq(block.blocker, viewer), inArray(block.blocked, targets))),
        db
          .select({ address: block.blocker })
          .from(block)
          .where(and(eq(block.blocked, viewer), inArray(block.blocker, targets))),
      ])
    : [[], [], [], []];
  const set = (rows: { address: Address }[]) => new Set(rows.map((row) => row.address));
  const [isFollowing, isFollowedBy, isBlocking, isBlockedBy] = [
    set(following),
    set(followedByTarget),
    set(blocking),
    set(blockedByTarget),
  ];
  return (target: Address): Relationship => ({
    following: isFollowing.has(target),
    followedBy: isFollowedBy.has(target),
    blocking: isBlocking.has(target),
    blockedBy: isBlockedBy.has(target),
  });
}

// Timelines: posts, quotes and reposts, without replies, newest first.

app.get('/timeline', async (c) => {
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const cursor = positionParam(c.req.query('cursor'));
  return c.json(
    await postsPage(
      [isNull(post.repliedPostId), notBlockedBy(viewer), relativeTo(post, 'before', cursor)],
      limitOf(c.req.query('limit')),
      viewer
    )
  );
});

/**
 * The viewer and who they follow. Given as a list, Postgres estimates how many posts they have, and reads the posts of
 * a few quiet accounts from the author index rather than scanning the whole timeline for them. Past
 * MAX_LISTED_AUTHORS, scanning the timeline finds their posts fast.
 */
async function timelineAuthors(viewer: Address) {
  const followed = await followedBy(viewer).limit(MAX_LISTED_AUTHORS + 1);
  return followed.length > MAX_LISTED_AUTHORS
    ? or(eq(post.author, viewer), inArray(post.author, followedBy(viewer)))
    : inArray(post.author, [viewer, ...followed.map((row) => row.followed)]);
}

app.get('/timeline/following', async (c) => {
  const viewer = requiredAddressParam(c.req.query('viewer'), 'viewer');
  const cursor = positionParam(c.req.query('cursor'));
  return c.json(
    await postsPage(
      [
        isNull(post.repliedPostId),
        await timelineAuthors(viewer),
        notBlockedBy(viewer),
        relativeTo(post, 'before', cursor),
      ],
      limitOf(c.req.query('limit')),
      viewer
    )
  );
});

// Posts

/** The posts `row` replies to, root first: one primary key lookup per level, the MAX_ANCESTORS closest. */
async function ancestorsOf(row: PostRow) {
  const ancestors: PostRow[] = [];
  let id = row.repliedPostId;
  while (id !== null && ancestors.length < MAX_ANCESTORS) {
    const [parent] = await db.select().from(post).where(eq(post.id, id)).limit(1);
    if (!parent) {
      break;
    }
    ancestors.unshift(parent);
    id = parent.repliedPostId;
  }
  return ancestors;
}

/** Posts by id, in the order asked, without the ones that don't exist. For lists kept elsewhere, like likes. */
app.get('/posts', async (c) => {
  const raw = c.req.query('ids') ?? '';
  const ids = raw ? raw.split(',') : [];
  if (ids.length > MAX_LIMIT || ids.some((id) => !/^\d{1,78}$/.test(id))) {
    throw badRequest(`ids is up to ${MAX_LIMIT} comma-separated post ids`);
  }
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const rows = ids.length
    ? await db
        .select()
        .from(post)
        .where(
          inArray(
            post.id,
            ids.map((id) => BigInt(id))
          )
        )
    : [];
  const views = await hydrate(rows, viewer);
  const byId = new Map(views.map((view) => [view.id, view]));
  return c.json({ items: ids.flatMap((id) => byId.get(BigInt(id).toString()) ?? []) });
});

app.get('/posts/:id', async (c) => {
  const rawId = c.req.param('id');
  if (!/^\d{1,78}$/.test(rawId)) {
    throw badRequest('Invalid post id');
  }
  const id = BigInt(rawId);
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const [row] = await db.select().from(post).where(eq(post.id, id)).limit(1);
  if (!row) {
    return c.json({ error: 'Post not found' }, 404);
  }
  const [ancestorRows, replyRows] = await Promise.all([
    ancestorsOf(row),
    db
      .select()
      .from(post)
      .where(and(eq(post.repliedPostId, id), eq(post.deleted, false), notBlockedBy(viewer)))
      .orderBy(asc(post.blockNumber), asc(post.logIndex))
      .limit(MAX_REPLIES),
  ]);
  const [view, ...rest] = await hydrate([row, ...ancestorRows, ...replyRows], viewer);
  const thread: ThreadView = {
    post: view!,
    ancestors: rest.slice(0, ancestorRows.length),
    replies: rest.slice(ancestorRows.length),
  };
  return c.json(thread);
});

app.get('/search/posts', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  if (query.length > MAX_SEARCH_LENGTH) {
    throw badRequest(`q is longer than ${MAX_SEARCH_LENGTH} characters`);
  }
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const cursor = positionParam(c.req.query('cursor'));
  const limit = limitOf(c.req.query('limit'));
  if (!query) {
    return c.json({ items: [], next: null } satisfies Page<PostView>);
  }
  const tag = /^#([\p{L}\d_]+)$/u.exec(query)?.[1];
  if (tag) {
    return c.json(await hashtagPage(tag.toLowerCase(), viewer, cursor, limit));
  }
  // A substring, with LIKE's wildcards and escape character taken literally.
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  return c.json(
    await postsPage(
      [ilike(post.content, pattern), notBlockedBy(viewer), relativeTo(post, 'before', cursor)],
      limit,
      viewer
    )
  );
});

/** Live posts with the hashtag, newest first, read from the hashtag's index rather than by scanning content. */
async function hashtagPage(
  tag: string,
  viewer: Address | null,
  cursor: Position | null,
  limit: number
): Promise<Page<PostView>> {
  const rows = await db
    .select({ post })
    .from(hashtag)
    .innerJoin(post, eq(post.id, hashtag.postId))
    .where(
      and(
        eq(hashtag.tag, tag),
        eq(post.deleted, false),
        notBlockedBy(viewer),
        relativeTo(hashtag, 'before', cursor)
      )
    )
    .orderBy(desc(hashtag.blockNumber), desc(hashtag.logIndex))
    .limit(limit + 1);
  return pageOf(
    rows.map((row) => row.post),
    limit,
    viewer
  );
}

// Trends: the hashtags of the most posts in the last `hours`, by block timestamp. Ties go to the most recent.

app.get('/trends', async (c) => {
  const hours = Number(c.req.query('hours') ?? 24);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_TREND_HOURS) {
    throw badRequest(`hours is an integer from 1 to ${MAX_TREND_HOURS}`);
  }
  const since = BigInt(Math.floor(Date.now() / 1000) - hours * 3600);
  const recent = db
    .select({ tag: hashtag.tag, blockNumber: hashtag.blockNumber, logIndex: hashtag.logIndex })
    .from(hashtag)
    .where(
      and(
        gte(hashtag.createdAt, since),
        notExists(
          db
            .select({ id: post.id })
            .from(post)
            .where(and(eq(post.id, hashtag.postId), eq(post.deleted, true)))
        )
      )
    )
    .orderBy(desc(hashtag.createdAt))
    .limit(MAX_TREND_SCAN)
    .as('recent');
  // A post has a hashtag once, so the rows of a hashtag are its posts.
  const posts = count();
  const latest = sql`max(${recent.blockNumber} * 4294967296 + ${recent.logIndex})`;
  const items: TrendView[] = await db
    .select({ tag: recent.tag, posts })
    .from(recent)
    .groupBy(recent.tag)
    .orderBy(desc(posts), desc(latest), asc(recent.tag))
    .limit(limitOf(c.req.query('limit'), 5));
  return c.json({ items });
});

// Accounts

app.get('/accounts', async (c) => {
  const owner = c.req.query('owner');
  const ownerAddress = addressParam(owner, 'owner');
  const query = c.req
    .query('q')
    ?.toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  const limit = limitOf(c.req.query('limit'));
  const where = ownerAddress
    ? eq(account.owner, ownerAddress)
    : query
      ? ilike(account.username, `${query.replaceAll('_', '\\_')}%`)
      : undefined;
  const rows = await db
    .select()
    .from(account)
    .where(where)
    .orderBy(
      query || ownerAddress ? asc(account.username) : desc(account.followers),
      desc(account.createdAt)
    )
    .limit(limit);
  return c.json({ items: rows.map(toAccountView), next: null } satisfies Page<AccountView>);
});

// Before /accounts/:handle, which would take "suggested" for a username.
app.get('/accounts/suggested', async (c) => {
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const rows = await db
    .select()
    .from(account)
    .where(
      viewer
        ? and(
            ne(account.address, viewer),
            notInArray(account.address, followedBy(viewer)),
            // Following them would fail, or show their posts again.
            notInArray(account.address, blockedBy(viewer)),
            notInArray(account.address, blockersOf(viewer))
          )
        : undefined
    )
    .orderBy(desc(account.followers), desc(account.createdAt))
    .limit(limitOf(c.req.query('limit')));
  return c.json({ items: rows.map(toAccountView), next: null } satisfies Page<AccountView>);
});

app.get('/accounts/:handle', async (c) => {
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const row = await findAccount(c.req.param('handle'));
  if (!row) {
    return c.json({ error: 'Account not found' }, 404);
  }
  const profile: ProfileView = {
    account: toAccountView(row),
    relationship:
      viewer && viewer !== row.address
        ? (await relationships(viewer, [row.address]))(row.address)
        : null,
  };
  return c.json(profile);
});

app.get('/accounts/:handle/posts', async (c) => {
  const viewer = addressParam(c.req.query('viewer'), 'viewer');
  const cursor = positionParam(c.req.query('cursor'));
  const row = await findAccount(c.req.param('handle'));
  if (!row) {
    return c.json({ error: 'Account not found' }, 404);
  }
  const withReplies = c.req.query('replies') === 'true';
  return c.json(
    await postsPage(
      [
        eq(post.author, row.address),
        withReplies ? undefined : isNull(post.repliedPostId),
        relativeTo(post, 'before', cursor),
      ],
      limitOf(c.req.query('limit')),
      viewer
    )
  );
});

/** Followers or followed accounts, most recent follow first. */
async function followList(
  handle: string,
  direction: 'followers' | 'following',
  cursor: Position | null,
  limit: number
): Promise<Page<AccountView> | null> {
  const row = await findAccount(handle);
  if (!row) {
    return null;
  }
  const [self, other] =
    direction === 'followers'
      ? [follow.followed, follow.follower]
      : [follow.follower, follow.followed];
  const edges = await db
    .select({ address: other, blockNumber: follow.blockNumber, logIndex: follow.logIndex })
    .from(follow)
    .where(and(eq(self, row.address), relativeTo(follow, 'before', cursor)))
    .orderBy(desc(follow.blockNumber), desc(follow.logIndex))
    .limit(limit + 1);
  const page = edges.slice(0, limit);
  const accountOf = await accountsByAddress(page.map((edge) => edge.address));
  return { items: page.map((edge) => accountOf(edge.address)), next: nextCursor(edges, limit) };
}

for (const direction of ['followers', 'following'] as const) {
  app.get(`/accounts/:handle/${direction}`, async (c) => {
    const page = await followList(
      c.req.param('handle'),
      direction,
      positionParam(c.req.query('cursor')),
      limitOf(c.req.query('limit'), 50)
    );
    if (!page) {
      return c.json({ error: 'Account not found' }, 404);
    }
    return c.json(page);
  });
}

app.get('/relationships', async (c) => {
  const viewer = requiredAddressParam(c.req.query('viewer'), 'viewer');
  const raw = (c.req.query('accounts') ?? '').split(',').filter((value) => value !== '');
  if (raw.length > MAX_LIMIT) {
    throw badRequest(`At most ${MAX_LIMIT} accounts`);
  }
  const targets = [...new Set(raw.map((value) => requiredAddressParam(value, 'account')))];
  const relationshipOf = await relationships(viewer, targets);
  return c.json(
    Object.fromEntries(
      targets.map((target) => [getAddress(target), relationshipOf(target)])
    ) satisfies Record<Address, Relationship>
  );
});

// Notifications, newest first

/** What the recipient sees: not from actors they blocked, nor about posts deleted since. */
function visibleNotifications(recipient: Address) {
  return and(
    eq(notification.recipient, recipient),
    notInArray(notification.actor, blockedBy(recipient)),
    notExists(
      db
        .select({ id: post.id })
        .from(post)
        .where(
          and(
            or(eq(post.id, notification.actorPostId), eq(post.id, notification.postId)),
            eq(post.deleted, true)
          )
        )
    )
  );
}

app.get('/notifications', async (c) => {
  const recipient = requiredAddressParam(c.req.query('account'), 'account');
  const type = c.req.query('type') ?? 'all';
  if (type !== 'all' && type !== 'mentions') {
    throw badRequest('type is all or mentions');
  }
  const cursor = positionParam(c.req.query('cursor'));
  const limit = limitOf(c.req.query('limit'));
  const rows = await db
    .select()
    .from(notification)
    .where(
      and(
        visibleNotifications(recipient),
        type === 'mentions' ? eq(notification.mentions, true) : undefined,
        relativeTo(notification, 'before', cursor)
      )
    )
    .orderBy(desc(notification.blockNumber), desc(notification.logIndex))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const [actorOf, posts] = await Promise.all([
    accountsByAddress(page.map((row) => row.actor)),
    // The recipient is the viewer of the posts.
    postViewsById(
      page.flatMap((row) => (row.postId === null ? [] : [row.postId])),
      recipient
    ),
  ]);
  const items = page.map((row): NotificationView => ({
    id: `${row.blockNumber}:${row.logIndex}`,
    type: row.type,
    actor: actorOf(row.actor),
    post: row.postId === null ? null : (posts.get(row.postId.toString()) ?? null),
    createdAt: row.createdAt.toString(),
  }));
  return c.json({ items, next: nextCursor(rows, limit) } satisfies Page<NotificationView>);
});

app.get('/notifications/unread', async (c) => {
  const recipient = requiredAddressParam(c.req.query('account'), 'account');
  const since = positionParam(c.req.query('since'), 'since');
  const rows = await db
    .select({ logIndex: notification.logIndex })
    .from(notification)
    .where(and(visibleNotifications(recipient), relativeTo(notification, 'after', since)))
    .limit(MAX_UNREAD);
  return c.json({ count: rows.length });
});

// Media

/**
 * A media's bytes: its chunks from offset 0, as long as they follow each other, and only once their SHA-256 is the
 * id, so a missing chunk or a partial upload is a 404 rather than a broken image. Served only as one of the image
 * types it sniffs as, never as what the author says it is, and sandboxed, so no media runs as a page of the app's
 * origin. The bytes behind an id never change, so caches keep them.
 */
app.get('/media/:author/:id', async (c) => {
  const author = requiredAddressParam(c.req.param('author'), 'author');
  const id = c.req.param('id').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) {
    throw badRequest('Invalid id');
  }
  if (MEDIA_BLOCKLIST.has(id)) {
    throw new HTTPException(451, { message: 'This image is unavailable' });
  }
  const chunks = await db
    .select({ offset: mediaChunk.offset, data: mediaChunk.data })
    .from(mediaChunk)
    .where(and(eq(mediaChunk.author, author), eq(mediaChunk.id, id as `0x${string}`)))
    .orderBy(asc(mediaChunk.offset));
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (chunk.offset === size) {
      parts.push(chunk.data);
      size += chunk.data.length;
    }
  }
  const bytes = Buffer.concat(parts);
  const type = size > 0 && (await mediaId(bytes)) === id ? sniffImageType(bytes) : null;
  if (!type) {
    throw new HTTPException(404, { message: 'Not found' });
  }
  return c.body(bytes, 200, {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
});

export default app;
