import { NextResponse } from 'next/server';
import { handle } from '@/lib/server/guard';
import {
  passportRedirectUri,
  requirePassport,
  safeReturnTo,
  startPassportSignIn,
} from '@/lib/server/passport';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/passport?returnTo=/path: sends the browser to Community Passport to sign in, with an email code. It
 * comes back to /api/auth/passport/callback. A navigation, not a fetch: the Passport's page takes over.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const settings = await requirePassport();
    const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));
    const { url, pending } = await startPassportSignIn(
      settings,
      passportRedirectUri(request),
      returnTo
    );
    const session = await getSession();
    session.passport = pending;
    await session.save();
    return NextResponse.redirect(url, { status: 303, headers: { 'cache-control': 'no-store' } });
  });
}
