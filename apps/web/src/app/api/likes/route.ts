import { NextResponse } from 'next/server';
import { isOwnedBy } from '@/lib/server/chain';
import { numberEnv } from '@/lib/server/env';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { likeablePostAuthor, parsePostId } from '@/lib/server/posts';
import { getSession } from '@/lib/server/session';
import { rateLimit, serverState } from '@/lib/server/state';

// Likes are Parallax's own, off-chain (Lens V3 has none): no relayer, no gas, so RELAY_PAUSED doesn't stop them.

export const dynamic = 'force-dynamic';

const MAX_IDS = 100;
const NO_STORE = { 'cache-control': 'no-store' };

/** GET /api/likes?ids=1,2,3: each post's like count, and whether the session's Account liked it. */
export async function GET(request: Request) {
  return handle(async () => {
    const ids = new URL(request.url).searchParams.get('ids') ?? '';
    const postIds = [
      ...new Set(
        ids
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      ),
    ];
    if (postIds.length > MAX_IDS) {
      throw new HttpError(400, `At most ${MAX_IDS} post ids`);
    }
    const { account } = await getSession();
    const counts = await serverState().likes.counts(postIds.map(parsePostId), account ?? null);
    return NextResponse.json(counts, { headers: NO_STORE });
  });
}

/** The like's Account (the session's, still owned by the wallet that signed in) and post. */
async function likeRequest(request: Request) {
  assertSameOrigin(request);
  const { owner, account } = await getSession();
  if (!owner || !account) {
    throw new HttpError(401, 'Sign in with a Lens account first');
  }
  const { postId } = (await request.json()) as { postId?: unknown };
  const id = parsePostId(postId);
  await rateLimit(`like:${account}`, numberEnv('LIKE_RATE_LIMIT_PER_MINUTE', 60), 60 * 1000);
  if (!(await isOwnedBy(account, owner))) {
    throw new HttpError(403, 'Your wallet no longer owns this account, sign in again');
  }
  return { account, postId: id };
}

async function likeCount(postId: string) {
  return (await serverState().likes.counts([postId], null))[postId]!.count;
}

/** Likes a live post. Liking again changes nothing. */
export async function POST(request: Request) {
  return handle(async () => {
    const { account, postId } = await likeRequest(request);
    const author = await likeablePostAuthor(postId);
    await serverState().likes.like(account, postId, author, new Date());
    return NextResponse.json(
      { liked: true, count: await likeCount(postId) },
      { headers: NO_STORE }
    );
  });
}

/** Unlikes a post, deleted or not. Unliking again changes nothing. */
export async function DELETE(request: Request) {
  return handle(async () => {
    const { account, postId } = await likeRequest(request);
    await serverState().likes.unlike(account, postId);
    return NextResponse.json(
      { liked: false, count: await likeCount(postId) },
      { headers: NO_STORE }
    );
  });
}
