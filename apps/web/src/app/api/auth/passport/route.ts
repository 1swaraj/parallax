import { NextResponse } from 'next/server';
import { HttpError } from '@/lib/server/guard';
import {
  backToApp,
  passportRedirectUri,
  requirePassport,
  safeReturnTo,
  startPassportSignIn,
} from '@/lib/server/passport';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/passport?returnTo=/path: sends the browser to Community Passport to sign in, with an email code. It
 * comes back to /api/auth/passport/callback. A navigation, not a fetch: the Passport's page takes over, and when it
 * can't, the member is sent back with `?signin_error=`, as from the callback.
 */
export async function GET(request: Request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));
  try {
    const settings = await requirePassport();
    const { url, pending } = await startPassportSignIn(
      settings,
      passportRedirectUri(request),
      returnTo
    );
    const session = await getSession();
    session.passport = pending;
    await session.save();
    return NextResponse.redirect(url, { status: 303, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof HttpError) return backToApp(request, returnTo, error.message);
    console.warn('Community Passport sign-in could not start:', error);
    return backToApp(request, returnTo, 'Community Passport could not sign you in. Try again.');
  }
}
