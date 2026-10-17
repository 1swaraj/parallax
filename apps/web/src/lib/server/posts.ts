import type { ThreadView } from '@lens-monad/protocol';
import type { Address } from 'viem';
import { indexerUrl } from './env';
import { HttpError } from './guard';

const MAX_UINT256 = 2n ** 256n - 1n;

/** A post id as clients send it: a uint256 in canonical decimal (no sign, no leading zeros). */
export function parsePostId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,77})$/.test(value) ||
    BigInt(value) > MAX_UINT256
  ) {
    throw new HttpError(400, 'Invalid post id');
  }
  return value;
}

/**
 * The author of a post that can be liked, from the indexer: 404 if it's unknown or deleted. A repost has no content
 * of its own, so its likes belong to the original (PostView.reposted).
 */
export async function likeablePostAuthor(postId: string): Promise<Address> {
  let response: Response;
  try {
    response = await fetch(`${indexerUrl()}/posts/${postId}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.error('Indexer unreachable', error);
    throw new HttpError(503, "Couldn't find the post, try again in a moment");
  }
  if (response.status === 404) {
    throw new HttpError(404, 'Post not found');
  }
  if (!response.ok) {
    throw new HttpError(503, "Couldn't find the post, try again in a moment");
  }
  const { post } = (await response.json()) as ThreadView;
  if (post.deleted) {
    throw new HttpError(404, 'Post not found');
  }
  if (post.repostedPostId) {
    throw new HttpError(400, 'Like the original post, not the repost');
  }
  return post.author.address;
}
