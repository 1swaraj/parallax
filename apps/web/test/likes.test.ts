// The likes store, in memory and in Postgres (when TEST_DATABASE_URL is set).

import { afterAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/server/db';
import {
  MAX_UNREAD,
  memoryLikeStore,
  postgresLikeStore,
  type LikeStore,
} from '../src/lib/server/likes';
import { randomAddress, randomChainId, TEST_DATABASE_URL, testDatabase } from './helpers';

let sql: Sql | undefined;
afterAll(() => sql?.end());

const stores: { name: string; enabled: boolean; create: () => LikeStore }[] = [
  { name: 'memory', enabled: true, create: memoryLikeStore },
  {
    name: 'postgres',
    enabled: !!TEST_DATABASE_URL,
    create: () => postgresLikeStore((sql ??= testDatabase()), randomChainId()),
  },
];

const at = (second: number) => new Date(Date.UTC(2026, 9, 18, 12, 0, second));

describe.each(stores)('$name likes', ({ enabled, create }) => {
  it.skipIf(!enabled)('counts likes per post, with the viewer’s, idempotently', async () => {
    const likes = create();
    const [alice, bob, carol] = [randomAddress(), randomAddress(), randomAddress()];
    await likes.like(alice, '1', bob, at(1));
    await likes.like(alice, '1', bob, at(2));
    await likes.like(carol, '1', bob, at(3));
    // Checksum casing doesn't matter.
    await likes.like(alice.toLowerCase() as typeof alice, '1', bob, at(4));
    expect(await likes.counts(['1', '2'], alice)).toEqual({
      '1': { count: 2, liked: true },
      '2': { count: 0, liked: false },
    });
    expect(await likes.counts(['1'], null)).toEqual({ '1': { count: 2, liked: false } });
    expect(await likes.counts(['1'], bob)).toEqual({ '1': { count: 2, liked: false } });
    expect(await likes.counts([], alice)).toEqual({});

    await likes.unlike(alice, '1');
    await likes.unlike(alice, '1');
    expect(await likes.counts(['1'], alice)).toEqual({ '1': { count: 1, liked: false } });
  });

  it.skipIf(!enabled)('pages through an account’s likes, newest first', async () => {
    const likes = create();
    const [alice, author] = [randomAddress(), randomAddress()];
    await likes.like(alice, '5', author, at(1));
    await likes.like(alice, '7', author, at(2));
    // Same time: the bigger post id first, compared as numbers.
    await likes.like(alice, '9', author, at(3));
    await likes.like(alice, '10', author, at(3));
    await likes.like(alice, '3', author, at(4));
    // Liking again keeps the first time.
    await likes.like(alice, '5', author, at(5));
    await likes.like(randomAddress(), '8', author, at(6));

    const seen = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await likes.mine(alice, { cursor, limit: 2 });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items);
      cursor = page.next;
      if (!cursor) break;
    }
    expect(seen).toEqual([
      { postId: '3', likedAt: at(4).toISOString() },
      { postId: '10', likedAt: at(3).toISOString() },
      { postId: '9', likedAt: at(3).toISOString() },
      { postId: '7', likedAt: at(2).toISOString() },
      { postId: '5', likedAt: at(1).toISOString() },
    ]);
    expect((await likes.mine(alice, { cursor: null, limit: 5 })).next).toBeNull();
    expect(await likes.mine(randomAddress(), { cursor: null, limit: 5 })).toEqual({
      items: [],
      next: null,
    });
  });

  it.skipIf(!enabled)(
    'lists likes others gave an author’s posts, and the unread ones',
    async () => {
      const likes = create();
      const [bob, alice, carol, dave] = [
        randomAddress(),
        randomAddress(),
        randomAddress(),
        randomAddress(),
      ];
      await likes.like(alice, '1', bob, at(1));
      await likes.like(carol, '1', bob, at(2));
      await likes.like(bob, '1', bob, at(3)); // a self-like: not a notification
      await likes.like(alice, '2', bob, at(4));
      await likes.like(alice, '3', dave, at(5)); // someone else's post

      const received = await likes.received(bob, { since: null, limit: 50 });
      expect(received).toEqual({
        items: [
          { postId: '2', liker: alice, likedAt: at(4).toISOString() },
          { postId: '1', liker: carol, likedAt: at(2).toISOString() },
          { postId: '1', liker: alice, likedAt: at(1).toISOString() },
        ],
        unread: 3,
      });
      expect((await likes.received(bob, { since: at(2), limit: 1 })).unread).toBe(1);
      expect((await likes.received(bob, { since: at(2), limit: 1 })).items).toHaveLength(1);
      expect(await likes.received(carol, { since: null, limit: 50 })).toEqual({
        items: [],
        unread: 0,
      });
    }
  );

  it.skipIf(!enabled)(`caps unread likes at ${MAX_UNREAD}`, async () => {
    const likes = create();
    const author = randomAddress();
    for (let i = 0; i < MAX_UNREAD + 5; i++) {
      await likes.like(randomAddress(), String(i), author, at(i % 60));
    }
    const received = await likes.received(author, { since: null, limit: 10 });
    expect(received.unread).toBe(MAX_UNREAD);
    expect(received.items).toHaveLength(10);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres likes', () => {
  it('keeps chains apart', async () => {
    sql ??= testDatabase();
    const [testnet, mainnet] = [
      postgresLikeStore(sql, randomChainId()),
      postgresLikeStore(sql, randomChainId()),
    ];
    const [alice, bob] = [randomAddress(), randomAddress()];
    await testnet.like(alice, '1', bob, at(1));
    expect(await mainnet.counts(['1'], alice)).toEqual({ '1': { count: 0, liked: false } });
    expect(await testnet.counts(['1'], alice)).toEqual({ '1': { count: 1, liked: true } });
  });
});
