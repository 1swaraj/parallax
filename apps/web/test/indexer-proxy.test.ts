import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyModeration, ModerationPolicy } from '../src/lib/moderation-policy';
import { account, accountView, other, postView, status } from './moderation-fixtures';
const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('../src/lib/server/moderation', () => ({ moderationSnapshot: mocks.snapshot }));
import { proxyIndexer } from '../src/lib/server/indexer-proxy';
import { currentConfig } from '../src/lib/server/instance-config';

let state = emptyModeration();
beforeEach(() => {
  state = emptyModeration();
  mocks.snapshot.mockResolvedValue(state);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const req = (path = 'timeline', method = 'GET') =>
  new Request(`https://app.example/indexer/${path}`, {
    method,
    headers: { 'if-none-match': 'old', cookie: 'private', authorization: 'Bearer private' },
  });

describe('runtime moderated indexer proxy', () => {
  it('uses runtime URLs, strips conditional/private headers and disables response caching', async () => {
    vi.stubEnv('INDEXER_URL', 'https://indexer-one.example/base');
    const send = vi.fn<typeof fetch>(async () =>
      Response.json(
        { items: [postView()], next: null },
        {
          headers: {
            etag: 'upstream',
            'cache-control': 'public, max-age=15',
            'set-cookie': 'private',
          },
        }
      )
    );
    const response = await proxyIndexer(req('timeline?limit=20'), ['timeline'], send);
    expect(send.mock.calls[0]![0]).toBe('https://indexer-one.example/base/timeline?limit=20');
    const options = send.mock.calls[0]![1]!;
    const headers = new Headers(options.headers);
    for (const name of ['if-none-match', 'cookie', 'authorization', 'range'])
      expect(headers.has(name)).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('etag')).toBe(false);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect((await response.json()).items).toHaveLength(1);
    vi.stubEnv('INDEXER_URL', 'https://indexer-two.example');
    await proxyIndexer(req('timeline?limit=20'), ['timeline'], send);
    expect(send.mock.calls[1]![0]).toBe('https://indexer-two.example/timeline?limit=20');
  });
  it('bounds timeouts and refuses redirects, traversal and raw query endpoints', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('timed out'));
    expect((await proxyIndexer(req(), ['timeline'], send)).status).toBe(504);
    send.mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'http://private.example' } })
    );
    expect((await proxyIndexer(req(), ['timeline'], send)).status).toBe(502);
    for (const path of [['..'], ['https://evil.example']])
      expect((await proxyIndexer(req(), path, send)).status).toBe(400);
    for (const path of [['sql'], ['graphql'], ['unknown']])
      expect((await proxyIndexer(req(), path, send)).status).toBe(404);
    send.mockResolvedValue(new Response('missing', { status: 404 }));
    expect((await proxyIndexer(req(), ['timeline'], send)).status).toBe(404);
  });
  it.each(['timeline', 'search/posts', 'accounts/alice/posts'])(
    'hides a post in %s, over-fetching with correct cursors',
    async (path) => {
      state.posts.set('1', { action: 'hide', reason: 'spam' });
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ items: [postView('1'), postView('2')], next: '20:1' })
        )
        .mockResolvedValueOnce(Response.json({ items: [postView('3')], next: '10:1' }));
      const response = await proxyIndexer(req(`${path}?limit=2`), path.split('/'), send);
      const page = await response.json();
      expect(page.items.map((p: { id: string }) => p.id)).toEqual(['2', '3']);
      expect(page.next).toBe('10:1');
      const second = new URL(send.mock.calls[1]![0] as string);
      expect(second.searchParams.get('limit')).toBe('1');
      expect(second.searchParams.get('cursor')).toBe('20:1');
    }
  );
  it('returns redacted hidden threads, quotes and bulk post reads; HEAD has no body', async () => {
    state.posts.set('1', { action: 'hide', reason: 'spam' });
    const send = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        post: postView(),
        ancestors: [postView()],
        replies: [postView(), postView('2', other)],
      })
    );
    const data = await (await proxyIndexer(req('posts/1'), ['posts', '1'], send)).json();
    expect(JSON.stringify(data.post)).not.toContain('hello');
    expect(data.post.moderation.hidden).toBe(true);
    expect(data.replies).toHaveLength(1);
    expect(await (await proxyIndexer(req('posts/1', 'HEAD'), ['posts', '1'], send)).text()).toBe(
      ''
    );
    send.mockResolvedValue(Response.json({ items: [postView(), postView('2', other)] }));
    const bulk = await (await proxyIndexer(req('posts?ids=1,2'), ['posts'], send)).json();
    expect(bulk.items.map((p: { id: string }) => p.id)).toEqual(['2']);
  });
  it('removes hidden actors from profile/search/follow reads', async () => {
    state.accounts.set(account, status({ hidden: true }));
    let send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ account: accountView() }));
    expect((await proxyIndexer(req('accounts/alice'), ['accounts', 'alice'], send)).status).toBe(
      404
    );
    for (const path of ['accounts', 'accounts/suggested', 'accounts/bob/followers']) {
      send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ items: [accountView(), accountView(other)], next: null })
        );
      expect(
        (await (await proxyIndexer(req(path), path.split('/'), send)).json()).items
      ).toHaveLength(1);
    }
  });
  it('filters notifications and recomputes unread totals', async () => {
    state.accounts.set(account, status({ hidden: true }));
    const hidden = { id: '20:0', type: 'follow', actor: accountView(), post: null, createdAt: '1' };
    const visible = { ...hidden, id: '19:0', actor: accountView(other) };
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ items: [hidden, visible], next: null }));
    expect(
      (await (await proxyIndexer(req('notifications'), ['notifications'], send)).json()).items
    ).toHaveLength(1);
    expect(
      await (
        await proxyIndexer(
          req('notifications/unread?since=18:0'),
          ['notifications', 'unread'],
          send
        )
      ).json()
    ).toEqual({ count: 1 });
    expect(
      await (
        await proxyIndexer(
          req('notifications/unread?since=19:0'),
          ['notifications', 'unread'],
          send
        )
      ).json()
    ).toEqual({ count: 0 });
  });
  it('counts trends only from visible posts in this instance', async () => {
    state.posts.set('1', { action: 'hide', reason: 'spam' });
    const send = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      new URL(input as string).pathname === '/trends'
        ? Response.json({
            items: [
              { tag: 'spam', posts: 99 },
              { tag: 'community', posts: 2 },
            ],
          })
        : Response.json({
            items:
              new URL(input as string).searchParams.get('q') === '#spam'
                ? [postView('1')]
                : [postView('2', other)],
            next: null,
          })
    );
    const data = await (await proxyIndexer(req('trends'), ['trends'], send)).json();
    expect(data).toEqual({ items: [{ tag: 'community', posts: 1 }] });
  });
});
