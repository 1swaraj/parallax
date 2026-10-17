import { getAddress, type Address } from 'viem';
import { migrate, type Sql } from './db';

// Likes are Parallax's own: Lens V3 has none on-chain. Accounts and authors are stored lowercase, post ids as their
// canonical decimal string, times with millisecond precision (so cursors round-trip through JavaScript dates).

export type LikeCount = { count: number; liked: boolean };
export type MyLike = { postId: string; likedAt: string };
export type ReceivedLike = { postId: string; liker: Address; likedAt: string };

/** At most this many unread likes are counted. */
export const MAX_UNREAD = 100;

export interface LikeStore {
  /** Idempotent: liking again keeps the first like's time. */
  like(account: Address, postId: string, postAuthor: Address, at: Date): Promise<void>;
  unlike(account: Address, postId: string): Promise<void>;
  /** Every id gets an entry; `liked` is the viewer's (false without one). */
  counts(postIds: string[], viewer: Address | null): Promise<Record<string, LikeCount>>;
  /** The account's likes, newest first. `cursor` is the previous page's `next`. */
  mine(
    account: Address,
    page: { cursor: string | null; limit: number }
  ): Promise<{ items: MyLike[]; next: string | null }>;
  /** Likes of the author's posts by others, newest first, and how many are newer than `since` (up to MAX_UNREAD). */
  received(
    author: Address,
    page: { since: Date | null; limit: number }
  ): Promise<{ items: ReceivedLike[]; unread: number }>;
}

/** A position in `mine`: the like's time and post, newest first. Opaque to clients. */
function cursorOf(like: { createdAt: Date; postId: string }) {
  return `${like.createdAt.getTime()}:${like.postId}`;
}

export function parseCursor(cursor: string): { time: Date; postId: string } | null {
  const match = /^(\d{1,15}):(0|[1-9]\d{0,77})$/.exec(cursor);
  return match ? { time: new Date(Number(match[1])), postId: match[2]! } : null;
}

/** Newest first, then by post id (as numbers: decimal strings compare by length first). */
function newestFirst(
  a: { createdAt: Date; postId: string },
  b: { createdAt: Date; postId: string }
) {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() ||
    b.postId.length - a.postId.length ||
    (b.postId > a.postId ? 1 : b.postId < a.postId ? -1 : 0)
  );
}

type Like = { account: string; postId: string; postAuthor: string; createdAt: Date };

/** Per process: for local development. */
export function memoryLikeStore(): LikeStore {
  const likes = new Map<string, Like>();
  const key = (account: string, postId: string) => `${account}:${postId}`;
  return {
    async like(account, postId, postAuthor, at) {
      const k = key(account.toLowerCase(), postId);
      if (!likes.has(k)) {
        likes.set(k, {
          account: account.toLowerCase(),
          postId,
          postAuthor: postAuthor.toLowerCase(),
          createdAt: at,
        });
      }
    },
    async unlike(account, postId) {
      likes.delete(key(account.toLowerCase(), postId));
    },
    async counts(postIds, viewer) {
      const result: Record<string, LikeCount> = {};
      for (const postId of postIds) {
        result[postId] = { count: 0, liked: false };
      }
      for (const like of likes.values()) {
        const entry = result[like.postId];
        if (entry) {
          entry.count++;
          entry.liked ||= like.account === viewer?.toLowerCase();
        }
      }
      return result;
    },
    async mine(account, { cursor, limit }) {
      const after = cursor ? parseCursor(cursor) : null;
      const sorted = [...likes.values()]
        .filter((like) => like.account === account.toLowerCase())
        .sort(newestFirst)
        // Strictly after the cursor, in newest-first order.
        .filter(
          (like) => !after || newestFirst({ createdAt: after.time, postId: after.postId }, like) < 0
        );
      return page(sorted, limit);
    },
    async received(author, { since, limit }) {
      const sorted = [...likes.values()]
        .filter(
          (like) => like.postAuthor === author.toLowerCase() && like.account !== like.postAuthor
        )
        .sort((a, b) => newestFirst(a, b) || (b.account > a.account ? 1 : -1));
      const unread = sorted.filter((like) => !since || like.createdAt > since).length;
      return {
        items: sorted.slice(0, limit).map(toReceived),
        unread: Math.min(unread, MAX_UNREAD),
      };
    },
  };
}

function page(sorted: { createdAt: Date; postId: string }[], limit: number) {
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((like) => ({ postId: like.postId, likedAt: like.createdAt.toISOString() })),
    next: sorted.length > limit && last ? cursorOf(last) : null,
  };
}

function toReceived(like: { postId: string; account: string; createdAt: Date }): ReceivedLike {
  return {
    postId: like.postId,
    liker: getAddress(like.account),
    likedAt: like.createdAt.toISOString(),
  };
}

/** Shared by every instance, per chain: one database can serve testnet and mainnet. */
export function postgresLikeStore(sql: Sql, chainId: number): LikeStore {
  type Row = { account: string; post_id: string; created_at: Date };
  const rows = (list: Row[]) =>
    list.map((row) => ({ account: row.account, postId: row.post_id, createdAt: row.created_at }));
  // Post ids are text: ordered as numbers by length, then lexically.
  const newest = () => sql`created_at DESC, length(post_id) DESC, post_id DESC`;
  return {
    async like(account, postId, postAuthor, at) {
      await migrate(sql);
      await sql`
        INSERT INTO lens_web.likes (chain_id, account, post_id, post_author, created_at)
        VALUES (${chainId}, ${account.toLowerCase()}, ${postId}, ${postAuthor.toLowerCase()}, ${at})
        ON CONFLICT DO NOTHING
      `;
    },
    async unlike(account, postId) {
      await migrate(sql);
      await sql`
        DELETE FROM lens_web.likes
        WHERE chain_id = ${chainId} AND account = ${account.toLowerCase()} AND post_id = ${postId}
      `;
    },
    async counts(postIds, viewer) {
      const result: Record<string, LikeCount> = {};
      for (const postId of postIds) {
        result[postId] = { count: 0, liked: false };
      }
      if (postIds.length === 0) {
        return result;
      }
      await migrate(sql);
      const found = await sql<{ post_id: string; count: number; liked: boolean }[]>`
        SELECT post_id, count(*)::int AS count, bool_or(account = ${viewer?.toLowerCase() ?? ''}) AS liked
        FROM lens_web.likes
        WHERE chain_id = ${chainId} AND post_id IN ${sql(postIds)}
        GROUP BY post_id
      `;
      for (const row of found) {
        result[row.post_id] = { count: row.count, liked: row.liked };
      }
      return result;
    },
    async mine(account, { cursor, limit }) {
      await migrate(sql);
      const after = cursor ? parseCursor(cursor) : null;
      // Rows strictly after the cursor in newest-first order.
      const before = after
        ? sql`AND (created_at < ${after.time} OR (created_at = ${after.time} AND (
            length(post_id) < ${after.postId.length}
            OR (length(post_id) = ${after.postId.length} AND post_id < ${after.postId})
          )))`
        : sql``;
      const found = await sql<Row[]>`
        SELECT account, post_id, created_at FROM lens_web.likes
        WHERE chain_id = ${chainId} AND account = ${account.toLowerCase()} ${before}
        ORDER BY ${newest()}
        LIMIT ${limit + 1}
      `;
      return page(rows(found), limit);
    },
    async received(author, { since, limit }) {
      await migrate(sql);
      const by = author.toLowerCase();
      const found = await sql<Row[]>`
        SELECT account, post_id, created_at FROM lens_web.likes
        WHERE chain_id = ${chainId} AND post_author = ${by} AND account <> post_author
        ORDER BY ${newest()}, account DESC
        LIMIT ${limit}
      `;
      const [{ unread }] = await sql<[{ unread: number }]>`
        SELECT count(*)::int AS unread FROM (
          SELECT 1 FROM lens_web.likes
          WHERE chain_id = ${chainId} AND post_author = ${by} AND account <> post_author
            ${since ? sql`AND created_at > ${since}` : sql``}
          LIMIT ${MAX_UNREAD}
        ) AS recent
      `;
      return { items: rows(found).map(toReceived), unread };
    },
  };
}
