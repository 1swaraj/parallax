import { NextResponse } from 'next/server';
import { handle, HttpError } from '@/lib/server/guard';
import { parseCursor } from '@/lib/server/likes';
import { pageLimit } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { serverState } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/** GET /api/likes/mine?cursor&limit: the posts the session's Account liked, newest first. */
export async function GET(request: Request) {
  return handle(async () => {
    const { account } = await getSession();
    if (!account) {
      throw new HttpError(401, 'Sign in with a Lens account first');
    }
    const params = new URL(request.url).searchParams;
    const cursor = params.get('cursor') || null;
    if (cursor && !parseCursor(cursor)) {
      throw new HttpError(400, 'Invalid cursor');
    }
    const page = await serverState().likes.mine(account, {
      cursor,
      limit: pageLimit(params.get('limit'), 20),
    });
    return NextResponse.json(page, { headers: { 'cache-control': 'no-store' } });
  });
}
