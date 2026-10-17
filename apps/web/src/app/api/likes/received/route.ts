import { NextResponse } from 'next/server';
import { handle, HttpError } from '@/lib/server/guard';
import { optionalTime, pageLimit } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { serverState } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/**
 * GET /api/likes/received?limit&since: likes of the session Account's posts by other Accounts, newest first, and how
 * many are newer than `since` (the client's last visit), up to 100.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const { account } = await getSession();
    if (!account) {
      throw new HttpError(401, 'Sign in with a Lens account first');
    }
    const params = new URL(request.url).searchParams;
    const received = await serverState().likes.received(account, {
      limit: pageLimit(params.get('limit'), 50),
      since: optionalTime(params.get('since'), 'since'),
    });
    return NextResponse.json(received, { headers: { 'cache-control': 'no-store' } });
  });
}
