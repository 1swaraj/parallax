import type { PostView } from '@lens-monad/protocol';
import { moderationSnapshot } from './moderation';
import { hiddenPost } from './moderation-reads';
import { indexerUrl } from './env';
import { HttpError } from './guard';

/** Likes are app-local reads too; neither their post IDs nor hidden actors should leak into notifications. */
export async function visibleLikes<T extends { postId: string; liker?: string }>(
  items: T[]
): Promise<T[]> {
  if (!items.length) return [];
  const state = await moderationSnapshot();
  const ids = [...new Set(items.map((item) => item.postId))];
  const response = await fetch(`${indexerUrl()}/posts?ids=${ids.join(',')}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new HttpError(503, 'Could not read liked posts');
  const posts = (await response.json()).items as PostView[];
  const visible = new Set(posts.filter((post) => !hiddenPost(post, state)).map((post) => post.id));
  return items.filter(
    (item) =>
      visible.has(item.postId) &&
      (!item.liker ||
        (!state.accounts.get(item.liker.toLowerCase())?.hidden &&
          !state.accounts.get(item.liker.toLowerCase())?.suspended))
  );
}
