import { describeLensError, lensErrorName } from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { booleanEnv, missingSponsorSettings } from './env';

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
 * sites can't make a signed-in user's browser post or follow.
 */
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
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

/** Refuses actions the relayers would pay for while paused, or while the settings that bound their spending lack. */
export function assertSponsorshipAvailable() {
  if (isPaused()) {
    throw new HttpError(503, 'Sponsored actions are paused, try again soon');
  }
  const missing = missingSponsorSettings();
  if (missing.length > 0) {
    console.error(`Sponsored actions are refused: set ${missing.join(' and ')}`);
    throw new HttpError(503, "Sponsorship isn't configured");
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
