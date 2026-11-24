import * as oidc from 'openid-client';
import { getAddress, isAddress, type Address } from 'viem';
import { appUrl } from './env';
import { currentConfig } from './instance-config';
import { HttpError } from './guard';
import { getSecret } from './secrets';

/**
 * Community Passport (github.com/bensprks/community-passport): one email sign-in and one Lens Account across
 * community apps. To this app it's an OpenID Connect provider whose ID token says one thing, the member's Lens Account
 * (`sub`), and the member's grant in its registry is what lets this community act for them: its relayers call
 * ClubForwarder.execute, the forwarder calls the registry, and the registry checks the grant.
 */
export type PassportSettings = {
  /** The Passport's URL, which is its OpenID Connect issuer. */
  issuer: string;
  /** What the Passport registered this community as. */
  clientId: string;
  clientSecret: string;
  /** The grant registry members grant this community in. */
  registry: Address;
  /** This community's ClubForwarder: the grantee members grant. */
  forwarder: Address;
};

/** This community's Passport settings, or null while any is missing: the app then offers no Passport sign-in. */
export async function passportSettings(): Promise<PassportSettings | null> {
  const { passportIssuer, passportClientId, grantRegistry, clubForwarder } = currentConfig();
  if (!passportIssuer || !passportClientId || !grantRegistry || !clubForwarder) return null;
  const clientSecret = await getSecret('passportClientSecret');
  if (!clientSecret) return null;
  return {
    issuer: passportIssuer,
    clientId: passportClientId,
    clientSecret,
    registry: getAddress(grantRegistry),
    forwarder: getAddress(clubForwarder),
  };
}

export async function requirePassport(): Promise<PassportSettings> {
  const settings = await passportSettings();
  if (!settings) throw new HttpError(404, 'Community Passport sign-in is not set up here');
  return settings;
}

/** Plain HTTP only for a Passport on this machine, in development. */
function isLoopback(issuer: string) {
  const { protocol, hostname } = new URL(issuer);
  return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

// The provider's metadata and keys change rarely: discover once per settings, and again after a while or a failure.
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
let discovered: { key: string; config: Promise<oidc.Configuration>; until: number } | undefined;

function configuration(settings: PassportSettings): Promise<oidc.Configuration> {
  const key = [settings.issuer, settings.clientId, settings.clientSecret].join('\n');
  if (discovered?.key === key && discovered.until > Date.now()) return discovered.config;
  const config = oidc.discovery(
    new URL(settings.issuer),
    settings.clientId,
    // The Passport signs ID tokens with ES256 (P-256), and authenticates clients with HTTP Basic.
    { id_token_signed_response_alg: 'ES256' },
    oidc.ClientSecretBasic(settings.clientSecret),
    {
      execute: [
        // OpenID Connect lets a client trust an ID token from the token endpoint on TLS alone; check its signature
        // against the Passport's published keys as well.
        oidc.enableNonRepudiationChecks,
        ...(isLoopback(settings.issuer) ? [oidc.allowInsecureRequests] : []),
      ],
    }
  );
  const entry = { key, config, until: Date.now() + DISCOVERY_TTL_MS };
  discovered = entry;
  config.catch(() => {
    if (discovered === entry) discovered = undefined;
  });
  return config;
}

/** What the app keeps in the session cookie between sending a member to the Passport and getting them back. */
export type PendingPassportSignIn = {
  state: string;
  nonce: string;
  verifier: string;
  /** A path in this app to come back to. */
  returnTo: string;
  /** When the sign-in started (ms): it expires after PENDING_TTL_MS. */
  at: number;
};

export const PENDING_TTL_MS = 10 * 60 * 1000;

/** Step 1: where to send the member, and what to remember until they come back. Authorization code with PKCE. */
export async function startPassportSignIn(
  settings: PassportSettings,
  redirectUri: string,
  returnTo: string
): Promise<{ url: URL; pending: PendingPassportSignIn }> {
  const config = await configuration(settings);
  const pending = {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    verifier: oidc.randomPKCECodeVerifier(),
    returnTo,
    at: Date.now(),
  };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  });
  return { url, pending };
}

/**
 * Step 2: the member is back with a one-time code. `callbackUrl` is the registered redirect URI with the query the
 * Passport sent back. The code is swapped for an ID token, server to server, and the token checked: signed by the
 * Passport, for this community, for this sign-in, and fresh. Returns the member's Lens Account.
 */
export async function finishPassportSignIn(
  settings: PassportSettings,
  pending: PendingPassportSignIn,
  callbackUrl: URL
): Promise<Address> {
  const config = await configuration(settings);
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const account = tokens.claims()?.sub;
  if (!account || !isAddress(account)) {
    throw new HttpError(502, 'Community Passport did not say which account signed in');
  }
  return getAddress(account);
}

/**
 * Where the Passport sends members back to. It has to be exactly the redirect URI the community registered, so it's
 * built from the app's URL (Admin → Network) when it's set: behind a proxy, the request's own URL can differ.
 */
export function passportRedirectUri(request: Request): string {
  return new URL('/api/auth/passport/callback', appUrl() ?? new URL(request.url).origin).toString();
}

/** A path in this app, and nothing else, so the callback can't be made to send members to another site. */
export function safeReturnTo(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) && !/[\r\n]/.test(value) ? value : '/';
}
