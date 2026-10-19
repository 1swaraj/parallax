import { describeLensError, lensErrorName } from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { APP_NAME } from '../brand';
import { appUrl, booleanEnv, missingSponsorSettings, relayerKeys } from './env';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The session cookie is SameSite=Lax, and state-changing routes only accept JSON from the app's own origin, so other
 * sites can't make a signed-in user's browser post or follow. The app's own host is NEXT_PUBLIC_APP_URL's when it's
 * set, as for sign-in messages: behind a proxy that doesn't forward it (a tunnel, a preview URL), Host names the
 * server instead.
 */
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const host =
    appUrl()?.host ?? request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) {
    throw new HttpError(403, 'Cross-origin request');
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
}

/** RELAY_PAUSED=true stops every action the relayers pay for. Users can still pay from their wallet. */
export function isPaused() {
  return booleanEnv('RELAY_PAUSED');
}

/**
 * Whether the relayers can pay right now: not paused, set up to bound their spending, and with keys. The client asks
 * (/api/sponsorship) to send actions from the user's wallet when they can't, rather than have them refused.
 */
export function isSponsorshipAvailable() {
  if (isPaused() || missingSponsorSettings().length > 0) {
    return false;
  }
  try {
    relayerKeys();
    return true;
  } catch {
    return false;
  }
}

/** Refuses actions the relayers would pay for while paused, or while the settings that bound their spending lack. */
export function assertSponsorshipAvailable() {
  if (isPaused()) {
    throw new HttpError(
      503,
      `${APP_NAME} isn't paying network fees right now. Try again soon, or pay from your wallet (Settings).`
    );
  }
  const missing = missingSponsorSettings();
  if (missing.length > 0) {
    console.error(`Sponsored actions are refused: set ${missing.join(' and ')}`);
    throw new HttpError(
      503,
      `${APP_NAME} can't pay network fees here yet. Pay from your wallet (Settings).`
    );
  }
}

/** Runs a route handler, turning thrown errors into JSON responses. */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (lensErrorName(error)) {
      return NextResponse.json({ error: describeLensError(error) }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Something went wrong, try again.' }, { status: 500 });
  }
}
