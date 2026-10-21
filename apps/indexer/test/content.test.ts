// Reading offchain metadata from the indexer's server: what fetchPublic refuses to reach (SSRF), its limits, and the
// content reader's cache.

import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { by, createContentReader, deadlineIn } from '../src/api/content';
import { fetchPublic, FetchRefused, isPublicAddress } from '../src/api/public-fetch';

describe('public addresses', () => {
  it('allows public unicast addresses only', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450::1']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '224.0.0.1',
      '198.18.0.1',
      '192.0.2.1',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::7f00:1',
      '2001:db8::1',
      '2002:7f00:1::1',
      'ff02::1',
      'localhost',
      'not an ip',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('fetching public URLs', () => {
  let server: Server;
  let port: number;
  const hits: { host: string | undefined; path: string | undefined }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ host: req.headers.host, path: req.url });
      if (req.url === '/post.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ lens: { content: 'gm' } }));
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: `https://other.example:${port}/post.json` });
        res.end();
      } else if (req.url === '/inward') {
        res.writeHead(301, { location: `https://internal.example:${port}/post.json` });
        res.end();
      } else if (req.url === '/downgrade') {
        res.writeHead(302, { location: `http://metadata.example:${port}/post.json` });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(307, { location: '/loop' });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-length': '2000' });
        res.end('x'.repeat(2000));
      } else if (req.url === '/streamed') {
        res.writeHead(200);
        res.write('x'.repeat(600));
        res.end('x'.repeat(600));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('{}'), 2_000).unref();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  // The test's DNS: these names are the local server, and internal.example a private address.
  const local = {
    timeoutMs: 1_000,
    maxBytes: 1_000,
    request: httpRequest,
    resolve: async (hostname: string) =>
      hostname === 'internal.example'
        ? [{ address: '10.0.0.1', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
    isAllowed: (address: string) => address === '127.0.0.1',
  };

  it('fetches from the address it checked, keeping the URL’s host', async () => {
    const { body, contentType } = await fetchPublic(
      `https://metadata.example:${port}/post.json`,
      local
    );
    expect(JSON.parse(body.toString())).toEqual({ lens: { content: 'gm' } });
    expect(contentType).toBe('application/json');
    expect(hits.at(-1)).toEqual({ host: `metadata.example:${port}`, path: '/post.json' });
  });

  it('refuses names with a private address, without connecting', async () => {
    const refused = (url: string, resolve = local.resolve) =>
      expect(
        fetchPublic(url, {
          ...local,
          resolve,
          request: () => {
            throw new Error('connected');
          },
        })
      ).rejects.toBeInstanceOf(FetchRefused);
    await refused(`https://internal.example:${port}/post.json`);
    // Every address the name has must be public, or a client could be sent to the other.
    await refused(`https://mixed.example/post.json`, async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.2', family: 4 },
    ]);
    await refused('https://unresolved.example/post.json', async () => []);
    // The real policy, with literal addresses and the real DNS for localhost.
    for (const url of [
      'https://127.0.0.1/post.json',
      'https://[::1]/post.json',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/post.json',
    ]) {
      await expect(
        fetchPublic(url, { timeoutMs: 1_000, maxBytes: 1_000 }),
        url
      ).rejects.toBeInstanceOf(FetchRefused);
    }
  });

  it('only fetches plain https URLs', async () => {
    for (const url of [
      `http://metadata.example:${port}/post.json`,
      'ftp://metadata.example/post.json',
      `https://user:pass@metadata.example:${port}/post.json`,
    ]) {
      await expect(fetchPublic(url, local), url).rejects.toBeInstanceOf(FetchRefused);
    }
  });

  it('checks each redirect like the URL', async () => {
    const { body } = await fetchPublic(`https://metadata.example:${port}/moved`, local);
    expect(JSON.parse(body.toString())).toEqual({ lens: { content: 'gm' } });
    expect(hits.at(-1)?.host).toBe(`other.example:${port}`);
    for (const path of ['/inward', '/downgrade', '/loop']) {
      await expect(
        fetchPublic(`https://metadata.example:${port}${path}`, local),
        path
      ).rejects.toBeInstanceOf(FetchRefused);
    }
  });

  it('caps the size and the time of a response', async () => {
    for (const path of ['/big', '/streamed']) {
      await expect(
        fetchPublic(`https://metadata.example:${port}${path}`, local),
        path
      ).rejects.toBeInstanceOf(FetchRefused);
    }
    const started = Date.now();
    await expect(
      fetchPublic(`https://metadata.example:${port}/slow`, { ...local, timeoutMs: 200 })
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
    await expect(fetchPublic(`https://metadata.example:${port}/missing`, local)).rejects.toThrow(
      'HTTP 404'
    );
  });
});

describe('the content reader', () => {
  const post = { lens: { content: 'from Grove' } };

  function reader(options: Parameters<typeof createContentReader>[0] = {}) {
    const fetched: string[] = [];
    let time = 0;
    const read = createContentReader({
      now: () => time,
      fetchJson: async (url) => {
        fetched.push(url);
        if (url.includes('broken')) {
          throw new Error('unreachable');
        }
        return post;
      },
      ...options,
    });
    return { read, fetched, advance: (ms: number) => (time += ms) };
  }

  it('reads inline metadata without fetching, and offchain metadata once', async () => {
    const { read, fetched } = reader();
    expect(
      await read.post('data:application/json,' + encodeURIComponent(JSON.stringify(post)))
    ).toMatchObject({ content: 'from Grove' });
    expect(fetched).toEqual([]);
    const [first, second] = await Promise.all([read.post('lens://abc'), read.post('lens://abc')]);
    expect(first).toEqual({ content: 'from Grove', image: null, media: null });
    expect(second).toEqual(first);
    expect(await read.post('lens://abc')).toEqual(first);
    expect(fetched).toEqual(['https://api.grove.storage/abc']);
  });

  it('reads profiles apart from posts', async () => {
    const { read } = reader({
      fetchJson: async () => ({ lens: { name: 'Stani', picture: 'lens://pic' } }),
    });
    expect(await read.profile('lens://profile')).toEqual({
      name: 'Stani',
      bio: null,
      picture: 'lens://pic',
    });
  });

  it('caches failures briefly, and reads again after', async () => {
    const { read, fetched, advance } = reader({ failureTtlMs: 1_000, ttlMs: 10_000 });
    expect(await read.post('lens://broken')).toBeNull();
    expect(await read.post('lens://broken')).toBeNull();
    expect(fetched).toHaveLength(1);
    advance(1_001);
    await read.post('lens://broken');
    expect(fetched).toHaveLength(2);
    await read.post('lens://fine');
    advance(9_000);
    await read.post('lens://fine');
    expect(fetched).toHaveLength(3);
    advance(1_001);
    await read.post('lens://fine');
    expect(fetched).toHaveLength(4);
  });

  it('never fetches what isn’t a content URI', async () => {
    const { read, fetched } = reader();
    for (const uri of ['http://example.com/x.json', 'javascript:alert(1)', '', 'lens://../x']) {
      expect(await read.post(uri)).toBeNull();
    }
    expect(fetched).toEqual([]);
  });

  it('fetches a few at a time, and skips reads past its queue without caching them', async () => {
    let active = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const read = createContentReader({
      concurrency: 2,
      maxQueued: 1,
      fetchJson: async () => {
        active++;
        most = Math.max(most, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return post;
      },
    });
    const reads = ['lens://1', 'lens://2', 'lens://3', 'lens://4'].map((uri) => read.post(uri));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read.stats()).toMatchObject({ active: 2, queued: 1 });
    // The fourth was over the queue: skipped, not cached as a failure.
    expect(await reads[3]).toBeNull();
    while (releases.length) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await Promise.all(reads.slice(0, 3))).toEqual([
      expect.objectContaining({ content: 'from Grove' }),
      expect.objectContaining({ content: 'from Grove' }),
      expect.objectContaining({ content: 'from Grove' }),
    ]);
    expect(most).toBe(2);
    expect(read.stats().entries).toBe(3);
  });

  it('keeps the most recently used entries', async () => {
    const { read, fetched } = reader({ maxEntries: 2 });
    await read.post('lens://a');
    await read.post('lens://b');
    await read.post('lens://a');
    await read.post('lens://c');
    await read.post('lens://a');
    expect(fetched).toEqual([
      'https://api.grove.storage/a',
      'https://api.grove.storage/b',
      'https://api.grove.storage/c',
    ]);
  });

  it('gives a page what’s in by its deadline, and keeps the rest for later', async () => {
    let release = () => {};
    const read = createContentReader({
      fetchJson: () => new Promise((resolve) => (release = () => resolve(post))),
    });
    expect(await by(read.post('lens://slow'), deadlineIn(20), null)).toBeNull();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await by(read.post('lens://slow'), deadlineIn(20), null)).toMatchObject({
      content: 'from Grove',
    });
  });
});
