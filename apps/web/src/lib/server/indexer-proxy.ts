import type {
  AccountView,
  NotificationView,
  PostView,
  ThreadView,
  TrendView,
} from '@lens-monad/protocol';
import { getInstanceConfig } from './instance-config';
import { moderationSnapshot } from './moderation';
import {
  filteredPage,
  hiddenAccount,
  hiddenPost,
  homeAllowed,
  moderatePost,
  moderateThread,
  visibleNotification,
} from './moderation-reads';
import { handle, HttpError } from './guard';
import { pageLimit } from './requests';

const NO_STORE = { 'cache-control': 'no-store' };
/** What a post image's response keeps from the indexer's: what it is, and how browsers may treat it. */
const MEDIA_HEADERS = [
  'content-type',
  'content-length',
  'content-security-policy',
  'x-content-type-options',
];
// The bytes behind an image never change, but moderators can hide its author: caches keep it 5 minutes, not for good.
const MEDIA_CACHE = 'public, max-age=300';
const MEDIA_ROUTE = /^media\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-f]{64})$/;

/**
 * A post image (`media/<author>/<id>`), as bytes. The indexer checks it against its id, serves it only as the image
 * type it sniffs as, and sandboxes it; this keeps those headers, and refuses images whose author moderators hid.
 */
async function proxyMedia(
  request: Request,
  base: string,
  path: string[],
  author: string,
  send: typeof fetch
): Promise<Response> {
  if (hiddenAccount({ address: author } as AccountView, await moderationSnapshot()))
    throw new HttpError(404, 'Not found');
  let response: Response;
  try {
    response = await send(`${base}/${path.map(encodeURIComponent).join('/')}`, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
  } catch {
    throw new HttpError(request.signal.aborted ? 499 : 504, 'The indexer did not respond');
  }
  if (response.status === 404 || response.status === 451)
    throw new HttpError(
      response.status,
      response.status === 404 ? 'Not found' : 'This image is unavailable'
    );
  if (!response.ok) throw new HttpError(502, 'Indexer request failed');
  const headers = new Headers({ 'cache-control': MEDIA_CACHE });
  for (const name of MEDIA_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === 'HEAD' ? null : response.body, { headers });
}

/** Only known REST reads are exposed. Raw indexer SQL/GraphQL would bypass instance visibility. */
export async function proxyIndexer(
  request: Request,
  path: string[],
  send: typeof fetch = fetch
): Promise<Response> {
  return handle(async () => {
    const config = await getInstanceConfig();
    if (!config.indexerUrl) throw new HttpError(503, 'The indexer is not configured yet');
    if (
      path.some(
        (part) => part === '.' || part === '..' || part.includes('/') || part.includes('\\')
      )
    )
      return new Response(null, { status: 400 });
    const route = path.join('/');
    const media = MEDIA_ROUTE.exec(route);
    if (media)
      return proxyMedia(request, config.indexerUrl.replace(/\/+$/, ''), path, media[1]!, send);
    if (
      !/^(status|timeline(?:\/following)?|posts(?:\/[0-9]{1,78})?|search\/posts|trends|accounts(?:\/[^/]+(?:\/(?:posts|followers|following))?)?|relationships|notifications(?:\/unread)?)$/.test(
        route
      )
    )
      throw new HttpError(404, 'Not found');
    const params = new URL(request.url).searchParams;
    const state = await moderationSnapshot();
    const read = async (segments: string[], query: URLSearchParams) => {
      let response: Response;
      try {
        response = await send(
          `${config.indexerUrl.replace(/\/+$/, '')}/${segments.map(encodeURIComponent).join('/')}?${query}`,
          {
            // Moderated responses cannot use upstream ETags, ranges or cached bodies.
            headers: { accept: 'application/json', 'accept-encoding': 'identity' },
            redirect: 'manual',
            cache: 'no-store',
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
          }
        );
      } catch {
        throw new HttpError(request.signal.aborted ? 499 : 504, 'The indexer did not respond');
      }
      if (response.status >= 300 && response.status < 400)
        throw new HttpError(502, 'Invalid indexer response');
      if (!response.ok)
        throw new HttpError(
          response.status,
          response.status === 404 ? 'Not found' : 'Indexer request failed'
        );
      return response.json();
    };
    const respond = (value: unknown) =>
      request.method === 'HEAD'
        ? new Response(null, { headers: NO_STORE })
        : Response.json(value, { headers: NO_STORE });
    const posts = (item: PostView) =>
      !hiddenPost(item, state) &&
      (!route.startsWith('timeline') || homeAllowed(item, config.moderation, state))
        ? moderatePost(item, state)
        : null;
    const notification = (item: NotificationView) =>
      visibleNotification(item, state)
        ? { ...item, post: item.post ? moderatePost(item.post, state) : null }
        : null;
    if (route === 'notifications/unread') {
      // Upstream's aggregate includes hidden actors/posts. Count the visible prefix here instead.
      const query = new URLSearchParams(params);
      query.delete('since');
      const since = params.get('since');
      if (since && !/^\d{1,20}:\d{1,9}$/.test(since)) throw new HttpError(400, 'Invalid since');
      let count = 0,
        cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        if (cursor) query.set('cursor', cursor);
        query.set('limit', '100');
        const page = await read(['notifications'], query);
        let done = false;
        for (const item of page.items as NotificationView[]) {
          if (since) {
            const [block, log] = item.id.split(':').map(BigInt),
              [sb, sl] = since.split(':').map(BigInt);
            if (block! < sb! || (block === sb && log! <= sl!)) {
              done = true;
              break;
            }
          }
          if (notification(item)) count++;
          if (count >= 100) {
            done = true;
            break;
          }
        }
        if (done || !page.next) break;
        if (page.next === cursor) throw new HttpError(502, 'Invalid indexer cursor');
        cursor = page.next;
      }
      return respond({ count });
    }
    if (route === 'trends') {
      const limit = pageLimit(params.get('limit'), 5);
      const hours = Number(params.get('hours') ?? 24);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168)
        throw new HttpError(400, 'Invalid hours');
      const candidates = await read(
        path,
        new URLSearchParams({ limit: String(Math.min(100, limit * 4)), hours: String(hours) })
      );
      // Counts are recomputed from up to 1,000 matching posts per candidate, including replies.
      const items = await Promise.all(
        (candidates.items as TrendView[]).map(async (trend) => {
          const page = await filteredPage<PostView>(
            async (cursor, size) => {
              const query = new URLSearchParams({ q: `#${trend.tag}`, limit: String(size) });
              if (cursor) query.set('cursor', cursor);
              return read(['search', 'posts'], query);
            },
            (post) =>
              !hiddenPost(post, state) &&
              homeAllowed(post, config.moderation, state) &&
              Number(post.createdAt) >= Date.now() / 1000 - hours * 3600
                ? post
                : null,
            100,
            null
          );
          return { tag: trend.tag, posts: page.items.length };
        })
      );
      return respond({
        items: items
          .filter((t) => t.posts > 0)
          .sort((a, b) => b.posts - a.posts || a.tag.localeCompare(b.tag))
          .slice(0, limit),
      });
    }
    if (route === 'status') return respond(await read(path, params));
    if (route === 'relationships') {
      const result = await read(path, params);
      for (const address of Object.keys(result))
        if (hiddenAccount({ address } as AccountView, state)) delete result[address];
      return respond(result);
    }
    if (path[0] === 'posts' && path.length === 2)
      return respond(moderateThread((await read(path, params)) as ThreadView, state));
    if (path[0] === 'accounts' && path.length === 2 && path[1] !== 'suggested') {
      const result = await read(path, params);
      if (hiddenAccount(result.account, state))
        throw new HttpError(404, 'This account is hidden by moderators');
      return respond(result);
    }
    if (route === 'posts') {
      const result = await read(path, params);
      return respond({ items: result.items.map(posts).filter(Boolean) });
    }
    const transform = (item: PostView | AccountView | NotificationView) =>
      route === 'notifications'
        ? notification(item as NotificationView)
        : route.startsWith('timeline') || route === 'search/posts' || path[2] === 'posts'
          ? posts(item as PostView)
          : hiddenAccount(item as AccountView, state)
            ? null
            : item;
    const limit = pageLimit(params.get('limit'), 20);
    return respond(
      await filteredPage(
        async (cursor, size) => {
          const query = new URLSearchParams(params);
          query.set('limit', String(size));
          if (cursor) query.set('cursor', cursor);
          else query.delete('cursor');
          return read(path, query);
        },
        transform,
        limit,
        params.get('cursor')
      )
    );
  });
}
