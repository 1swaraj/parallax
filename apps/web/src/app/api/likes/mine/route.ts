import { NextResponse } from 'next/server';
import { isOwnedBy } from '@/lib/server/chain';
import { handle, HttpError } from '@/lib/server/guard';
import { parseCursor } from '@/lib/server/likes';
import { pageLimit } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { serverState } from '@/lib/server/state';
import { assertAccess } from '@/lib/server/moderation';
import { visibleLikes } from '@/lib/server/moderation-likes';

export const dynamic = 'force-dynamic';

/** GET /api/likes/mine?cursor&limit: the posts the session's Account liked, newest first. */
export async function GET(request: Request) {
  return handle(async () => {
    const { owner, account } = await getSession();
    if (!owner || !account) {
      throw new HttpError(401, 'Sign in with a Lens account first');
    }
    if (!(await isOwnedBy(account, owner))) {
      throw new HttpError(403, 'Your wallet no longer owns this account, sign in again');
    }
    await assertAccess(owner, account);
    const params = new URL(request.url).searchParams;
    const cursor = params.get('cursor') || null;
    if (cursor && !parseCursor(cursor)) {
      throw new HttpError(400, 'Invalid cursor');
    }
    const limit = pageLimit(params.get('limit'), 20);
    const page = { items: [] as { postId: string; likedAt: string }[], next: cursor };
    for (let i = 0; i < 10; i++) {
      const batch = await serverState().likes.mine(account, {
        cursor: page.next,
        limit: limit - page.items.length,
      });
      page.items.push(...(await visibleLikes(batch.items)));
      page.next = batch.next;
      if (!page.next || page.items.length >= limit) break;
    }
    return NextResponse.json(page, { headers: { 'cache-control': 'no-store' } });
  });
}
