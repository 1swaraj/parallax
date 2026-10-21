import {
  contentUrl,
  DEFAULT_GATEWAYS,
  parseDataURI,
  readPostMetadata,
  readProfileMetadata,
  type Gateways,
  type PostMetadata,
  type Profile,
} from '@lens-monad/protocol';
import { fetchPublic } from './public-fetch';

// Offchain Lens metadata, read when the API serves a post or an Account rather than when the indexer indexes it:
// Lens Chain's 21M posts point at Grove, IPFS, Arweave or any https server, and fetching each one while indexing would
// take weeks, and make the index depend on those servers. So the API reads the metadata of what a page shows, through
// a cache, and a page shows whatever is in by its deadline: the rest is in the cache for the next one.

export type ContentReaderOptions = {
  gateways?: Gateways;
  /** Per fetch, which carries on past a page's deadline to fill the cache. */
  timeoutMs?: number;
  /** Lens metadata is small: a 25,000-character article fits many times. */
  maxBytes?: number;
  /** Fetches at once; more wait their turn, up to `maxQueued`, and the rest are skipped. */
  concurrency?: number;
  maxQueued?: number;
  /** Entries, and their total size in characters, the cache keeps. The oldest go first. */
  maxEntries?: number;
  maxCachedChars?: number;
  /** How long a read, and a failed one, stays cached. */
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
  /** GETs a URL's JSON (fetchPublic by default). */
  fetchJson?: (url: string) => Promise<unknown>;
};

type Entry = { expires: number; value: unknown; size: number };

class Busy extends Error {}

export function createContentReader({
  gateways = DEFAULT_GATEWAYS,
  timeoutMs = 8_000,
  maxBytes = 256 * 1024,
  concurrency = 16,
  maxQueued = 1_000,
  maxEntries = 20_000,
  maxCachedChars = 32 * 1024 * 1024,
  ttlMs = 15 * 60_000,
  failureTtlMs = 60_000,
  now = Date.now,
  fetchJson = async (url) =>
    JSON.parse((await fetchPublic(url, { timeoutMs, maxBytes })).body.toString('utf-8')),
}: ContentReaderOptions = {}) {
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<unknown>>();
  let cachedChars = 0;
  let active = 0;
  const queue: (() => void)[] = [];

  function remember(key: string, value: unknown, ttl: number) {
    const size = key.length + (value === null ? 0 : JSON.stringify(value).length);
    const previous = cache.get(key);
    if (previous) {
      cachedChars -= previous.size;
      cache.delete(key);
    }
    cache.set(key, { expires: now() + ttl, value, size });
    cachedChars += size;
    for (const [oldest, entry] of cache) {
      if (cache.size <= maxEntries && cachedChars <= maxCachedChars) {
        break;
      }
      cache.delete(oldest);
      cachedChars -= entry.size;
    }
  }

  /** Runs `run` in one of the `concurrency` slots, waiting for one if need be: a finished read hands its slot on. */
  async function withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (active < concurrency) {
      active++;
    } else if (queue.length < maxQueued) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      throw new Busy();
    }
    try {
      return await run();
    } finally {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  }

  /** `read`'s result for `uri`: cached, in flight, or fetched now. Null when it can't be read. */
  function cached<T>(kind: string, uri: string, read: (json: unknown) => T | null) {
    const key = `${kind}:${uri}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      // Most recently used last, so eviction takes the least recently used.
      cache.delete(key);
      cache.set(key, hit);
      return Promise.resolve(hit.value as T | null);
    }
    const pending = inFlight.get(key);
    if (pending) {
      return pending as Promise<T | null>;
    }
    const url = contentUrl(uri, gateways);
    if (!url) {
      return Promise.resolve(null);
    }
    const promise = withSlot(() => fetchJson(url))
      .then((json) => {
        const value = read(json);
        remember(key, value, value === null ? failureTtlMs : ttlMs);
        return value;
      })
      .catch((error) => {
        // Too busy says nothing about the metadata: the next page tries again.
        if (!(error instanceof Busy)) {
          remember(key, null, failureTtlMs);
        }
        return null;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  /** Inline metadata at once, offchain metadata through the cache. */
  function metadata<T>(kind: string, uri: string, read: (json: unknown) => T | null) {
    return uri.startsWith('data:')
      ? Promise.resolve(read(parseDataURI(uri)))
      : cached(kind, uri, read);
  }

  return {
    gateways,
    post: (uri: string): Promise<PostMetadata | null> => metadata('post', uri, readPostMetadata),
    profile: (uri: string): Promise<Profile | null> =>
      metadata('profile', uri, readProfileMetadata),
    /** For tests and health: what the cache holds. */
    stats: () => ({ entries: cache.size, chars: cachedChars, active, queued: queue.length }),
  };
}

export type ContentReader = ReturnType<typeof createContentReader>;

/** The value, or `fallback` if it isn't there by `deadline`. */
export function by<T>(promise: Promise<T>, deadline: Promise<void>, fallback: T): Promise<T> {
  return Promise.race([promise, deadline.then(() => fallback)]);
}

/** A promise that resolves after `ms`, for `by`, without keeping the process alive. */
export function deadlineIn(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
