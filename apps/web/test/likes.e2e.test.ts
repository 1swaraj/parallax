// Likes, end to end: Parallax's own, off-chain. Alice posts, Bob likes it; the counts, the liked flag, Bob's likes,
// Alice's received likes, and the guards.

import {
  createPost,
  deletePost,
  repost,
  textOnlyPost,
  toDataURI,
  type Page,
  type PostView,
} from '@lens-monad/protocol';
import { describe, expect, it } from 'vitest';
import { APP, contracts, indexed, user } from './e2e';

type Member = ReturnType<typeof user> & { account: `0x${string}`; name: string };

async function member(prefix: string): Promise<Member> {
  const u = user();
  expect((await u.signIn()).status).toBe(200);
  const name = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const signUp = await u.call<{ account: `0x${string}` }>('/api/signup', {
    method: 'POST',
    body: { username: name },
  });
  expect(signUp.status, signUp.body.error).toBe(200);
  return Object.assign(u, { account: signUp.body.account, name });
}

/** Relays a call and waits for the indexer to show the member's newest post. */
async function newestPost(m: Member, call: { target: `0x${string}`; data: `0x${string}` }) {
  const before = await indexed<Page<PostView>>(`/accounts/${m.name}/posts`, () => true);
  const sent = await m.call('/api/relay', { method: 'POST', body: call });
  expect(sent.status, sent.body.error).toBe(200);
  const page = await indexed<Page<PostView>>(
    `/accounts/${m.name}/posts`,
    (p) => p.items.length > before.items.length
  );
  return page.items[0]!.id;
}

describe('likes', () => {
  it('likes, counts, lists and unlikes', async () => {
    const [alice, bob] = await Promise.all([member('liked'), member('liker')]);
    const postId = await newestPost(
      alice,
      createPost(contracts.LensGlobalFeed, alice.account, toDataURI(textOnlyPost('like me')))
    );
    const anonymous = user();

    const none = await fetch(`${APP}/api/likes?ids=${postId}`);
    expect(none.headers.get('cache-control')).toBe('no-store');
    expect(await none.json()).toEqual({ [postId]: { count: 0, liked: false } });

    const liked = await bob.call('/api/likes', { method: 'POST', body: { postId } });
    expect(liked).toMatchObject({ status: 200, body: { liked: true, count: 1 } });
    // Idempotent.
    const again = await bob.call('/api/likes', { method: 'POST', body: { postId } });
    expect(again).toMatchObject({ status: 200, body: { liked: true, count: 1 } });
    // Liking your own post is allowed, but isn't a notification.
    const own = await alice.call('/api/likes', { method: 'POST', body: { postId } });
    expect(own).toMatchObject({ status: 200, body: { liked: true, count: 2 } });

    expect((await bob.call(`/api/likes?ids=${postId},1`)).body).toEqual({
      [postId]: { count: 2, liked: true },
      '1': { count: 0, liked: false },
    });
    expect((await anonymous.call(`/api/likes?ids=${postId}`)).body).toEqual({
      [postId]: { count: 2, liked: false },
    });

    const mine = await bob.call<{ items: { postId: string; likedAt: string }[]; next: null }>(
      '/api/likes/mine?limit=10'
    );
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([{ postId, likedAt: expect.any(String) }]);
    expect(mine.body.next).toBeNull();

    const received = await alice.call<{
      items: { postId: string; liker: string; likedAt: string }[];
      unread: number;
    }>('/api/likes/received');
    expect(received.body).toEqual({
      items: [{ postId, liker: bob.account, likedAt: mine.body.items[0]!.likedAt }],
      unread: 1,
    });
    const later = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    expect((await alice.call(`/api/likes/received?since=${later}`)).body).toMatchObject({
      unread: 0,
    });

    const unliked = await bob.call('/api/likes', { method: 'DELETE', body: { postId } });
    expect(unliked).toMatchObject({ status: 200, body: { liked: false, count: 1 } });
    const unlikedAgain = await bob.call('/api/likes', { method: 'DELETE', body: { postId } });
    expect(unlikedAgain).toMatchObject({ status: 200, body: { liked: false, count: 1 } });
    expect((await alice.call('/api/likes/received')).body).toEqual({ items: [], unread: 0 });
  });

  it('refuses signed-out users, bad ids, unknown, deleted and reposted posts', async () => {
    const anonymous = user();
    expect(
      (await anonymous.call('/api/likes', { method: 'POST', body: { postId: '1' } })).status
    ).toBe(401);
    expect(
      (await anonymous.call('/api/likes', { method: 'DELETE', body: { postId: '1' } })).status
    ).toBe(401);
    expect((await anonymous.call('/api/likes/mine')).status).toBe(401);
    expect((await anonymous.call('/api/likes/received')).status).toBe(401);
    // Signed in, but without an Account yet.
    const owner = user();
    await owner.signIn();
    expect((await owner.call('/api/likes', { method: 'POST', body: { postId: '1' } })).status).toBe(
      401
    );

    const alice = await member('guard');
    for (const postId of ['abc', '01', '-1', '1.5', (2n ** 256n).toString(), 1, null]) {
      const bad = await alice.call('/api/likes', { method: 'POST', body: { postId } });
      expect(bad, String(postId)).toMatchObject({
        status: 400,
        body: { error: 'Invalid post id' },
      });
    }
    expect((await alice.call('/api/likes?ids=1,x')).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    expect((await alice.call(`/api/likes?ids=${tooMany}`)).status).toBe(400);
    expect((await alice.call('/api/likes/mine?limit=0')).status).toBe(400);
    expect((await alice.call('/api/likes/mine?cursor=nope')).status).toBe(400);
    expect((await alice.call('/api/likes/received?since=yesterday')).status).toBe(400);

    const unknown = await alice.call('/api/likes', { method: 'POST', body: { postId: '12345' } });
    expect(unknown).toMatchObject({ status: 404, body: { error: 'Post not found' } });

    const crossOrigin = await alice.call('/api/likes', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { postId: '1' },
    });
    expect(crossOrigin.status).toBe(403);

    const postId = await newestPost(
      alice,
      createPost(contracts.LensGlobalFeed, alice.account, toDataURI(textOnlyPost('short-lived')))
    );
    const repostId = await newestPost(
      alice,
      repost(contracts.LensGlobalFeed, alice.account, BigInt(postId))
    );
    const ofRepost = await alice.call('/api/likes', { method: 'POST', body: { postId: repostId } });
    expect(ofRepost).toMatchObject({
      status: 400,
      body: { error: 'Like the original post, not the repost' },
    });

    const sent = await alice.call('/api/relay', {
      method: 'POST',
      body: deletePost(contracts.LensGlobalFeed, BigInt(postId)),
    });
    expect(sent.status, sent.body.error).toBe(200);
    await indexed<{ post: PostView }>(`/posts/${postId}`, (thread) => thread.post.deleted);
    const ofDeleted = await alice.call('/api/likes', { method: 'POST', body: { postId } });
    expect(ofDeleted).toMatchObject({ status: 404, body: { error: 'Post not found' } });
  });
});
