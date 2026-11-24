import { NextResponse } from 'next/server';
import { ownerOf } from '@/lib/server/chain';
import { appUrl } from '@/lib/server/env';
import { handle, HttpError } from '@/lib/server/guard';
import { assertAccess, rememberExternalAccount } from '@/lib/server/moderation';
import {
  finishPassportSignIn,
  passportRedirectUri,
  PENDING_TTL_MS,
  requirePassport,
} from '@/lib/server/passport';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/passport/callback: Community Passport sends the member back here with a one-time code. The app swaps
 * it for an ID token naming the member's Lens Account, and signs them in as that Account. Their grant is what lets
 * this community act for them (signedInMember). Errors go back to the app as `?signin_error=`, not as a JSON page.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await getSession();
    const pending = session.passport;
    // A sign-in under way is good for one attempt.
    session.passport = undefined;
    const back = (path: string, error?: string) => {
      const url = new URL(path, appUrl() ?? request.url);
      if (error) url.searchParams.set('signin_error', error);
      return NextResponse.redirect(url, { status: 303, headers: { 'cache-control': 'no-store' } });
    };
    const params = new URL(request.url).searchParams;
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) {
      await session.save();
      return back('/', 'That sign-in expired. Try again.');
    }
    if (params.get('error')) {
      await session.save();
      return back(
        pending.returnTo,
        params.get('error') === 'access_denied'
          ? 'Sign-in was cancelled.'
          : 'Community Passport could not sign you in. Try again.'
      );
    }
    try {
      const settings = await requirePassport();
      // The redirect URI the Passport knows, with the code and state it sent back.
      const callback = new URL(passportRedirectUri(request));
      callback.search = new URL(request.url).search;
      const account = await finishPassportSignIn(settings, pending, callback);
      const holder = await ownerOf(account);
      if (!holder) throw new HttpError(502, 'That account could not be read. Try again.');
      // A brand-new Account may not be indexed yet: its creation time is recorded on a later poll (/api/auth/session).
      await rememberExternalAccount(account, holder).catch(() => {});
      await assertAccess(holder, account);
      Object.assign(session, {
        owner: undefined,
        nonce: undefined,
        nonceAt: undefined,
        account,
        via: 'passport',
        holder,
      });
      await session.save();
      return back(pending.returnTo);
    } catch (error) {
      await session.save();
      if (error instanceof HttpError) return back(pending.returnTo, error.message);
      console.warn('Community Passport sign-in failed:', error);
      return back(pending.returnTo, 'Community Passport could not sign you in. Try again.');
    }
  });
}
