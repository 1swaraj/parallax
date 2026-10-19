import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyIndexer } from '../src/lib/server/indexer-proxy';
afterEach(() => vi.unstubAllEnvs());

describe('runtime indexer proxy', () => {
  it('uses runtime URLs, streams bodies and preserves cache and conditional headers', async () => {
    vi.stubEnv('INDEXER_URL', 'https://indexer-one.example/base');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('chunk'));
        c.close();
      },
    });
    const send = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: {
          'cache-control': 'public, max-age=15',
          etag: 'version',
          'set-cookie': 'upstream=secret',
          connection: 'keep-alive',
        },
      })
    );
    const request = new Request('https://app.example/indexer/timeline?limit=20', {
      headers: {
        'if-none-match': 'old',
        cookie: 'lens_session=private',
        authorization: 'Bearer private',
      },
    });
    const response = await proxyIndexer(request, ['timeline'], send);
    expect(send.mock.calls[0]![0]).toBe('https://indexer-one.example/base/timeline?limit=20');
    const options = send.mock.calls[0]![1];
    expect(options.headers.get('if-none-match')).toBe('old');
    expect(options.headers.has('cookie')).toBe(false);
    expect(options.headers.has('authorization')).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(response.body).toBe(stream);
    expect(await response.text()).toBe('chunk');
    expect(response.headers.get('cache-control')).toBe('public, max-age=15');
    expect(response.headers.get('etag')).toBe('version');
    expect(response.headers.has('set-cookie')).toBe(false);
    vi.stubEnv('INDEXER_URL', 'https://indexer-two.example');
    send.mockResolvedValue(new Response(null, { status: 304, headers: { etag: 'v2' } }));
    expect((await proxyIndexer(request, ['timeline'], send)).status).toBe(304);
    expect(send.mock.calls[1]![0]).toBe('https://indexer-two.example/timeline?limit=20');
  });
  it('bounds timeouts, handles upstream errors and refuses redirects and traversal', async () => {
    const request = new Request('https://app.example/indexer/x');
    const send = vi.fn().mockRejectedValue(new Error('timed out'));
    expect((await proxyIndexer(request, ['x'], send)).status).toBe(504);
    send.mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'http://private.example' } })
    );
    expect((await proxyIndexer(request, ['x'], send)).status).toBe(502);
    expect((await proxyIndexer(request, ['..'], send)).status).toBe(400);
    expect((await proxyIndexer(request, ['https://evil.example'], send)).status).toBe(400);
    send.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await proxyIndexer(request, ['missing'], send)).status).toBe(404);
  });
});
