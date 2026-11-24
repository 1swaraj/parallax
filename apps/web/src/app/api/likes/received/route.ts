import { NextResponse } from 'next/server';
import { handle } from '@/lib/server/guard';
import { optionalTime, pageLimit } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { serverState } from '@/lib/server/state';
import { assertAccess } from '@/lib/server/moderation';
import { signedInMember } from '@/lib/server/member';
import { visibleLikes } from '@/lib/server/moderation-likes';

export const dynamic = 'force-dynamic';

/**
 * GET /api/likes/received?limit&since: likes of the session Account's posts by other Accounts, newest first, and how
 * many are newer than `since` (the client's last visit), up to 100.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const { owner, account } = await signedInMember(await getSession());
    await assertAccess(owner, account);
    const params = new URL(request.url).searchParams;
    const received = await serverState().likes.received(account, {
      limit: 100,
      since: optionalTime(params.get('since'), 'since'),
    });
    const items = await visibleLikes(received.items);
    const since = optionalTime(params.get('since'), 'since');
    return NextResponse.json(
      {
        items: items.slice(0, pageLimit(params.get('limit'), 50)),
        unread: items.filter((item) => !since || new Date(item.likedAt) > since).length,
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
