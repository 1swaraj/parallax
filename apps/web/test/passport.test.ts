// Community Passport sign-in (lib/server/passport.ts) against a stand-in OpenID provider that behaves like the
// Passport's (community-passport, apps/passport/src/oidc.ts): discovery, ES256 ID tokens, HTTP Basic client
// authentication, PKCE required, and an ID token whose `sub` is the member's Lens Account.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstanceConfig, publicConfig, resolveConfig } from '../src/lib/instance-schema';
import { HttpError } from '../src/lib/server/guard';
import {
  finishPassportSignIn,
  safeReturnTo,
  startPassportSignIn,
  type PassportSettings,
  type PendingPassportSignIn,
} from '../src/lib/server/passport';

const CLIENT_ID = 'queens-book-club';
const CLIENT_SECRET = 'a-long-random-client-secret';
const REDIRECT_URI = 'https://club.example/api/auth/passport/callback';
const ACCOUNT = '0x9ab696d9333813530b90188b2f2cd0c78a1c049d';

const signingKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const published = signingKey();
const KID = 'passport-key';

/** What the next token request returns, and what it was asked. */
let issue: (request: { nonce: string }) => Record<string, unknown>;
let signWith: KeyObject = published.privateKey;
let tokenRequests: { authorization?: string; body: URLSearchParams }[] = [];
const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();

/**
 * HTTP Basic client authentication, read as oidc-provider (the Passport's library) reads it: each part is
 * form-urlencoded first (RFC 6749, section 2.3.1), which openid-client does.
 */
function basicCredentialsMatch(header: string | undefined) {
  if (!header?.startsWith('Basic ')) return false;
  const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  const decode = (part = '') => decodeURIComponent(part.replace(/\+/g, '%20'));
  return decode(id) === CLIENT_ID && decode(secret) === CLIENT_SECRET;
}

let server: Server;
let issuer: string;

function idToken(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' })).toString(
    'base64url'
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: signWith,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, {
        keys: [
          { ...published.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' },
        ],
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = new URLSearchParams(raw);
      tokenRequests.push({ authorization: req.headers.authorization, body });
      const code = codes.get(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (
        !code ||
        !basicCredentialsMatch(req.headers.authorization) ||
        body.get('redirect_uri') !== code.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !== code.challenge
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, {
        access_token: 'opaque',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken(issue({ nonce: code.nonce })),
      });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  tokenRequests = [];
  signWith = published.privateKey;
  issue = ({ nonce }) => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: issuer, aud: CLIENT_ID, sub: ACCOUNT, nonce, iat: now, exp: now + 300 };
  };
});

const settings = (): PassportSettings => ({
  issuer,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  registry: '0x00000000000000000000000000000000000000a1',
  forwarder: '0x00000000000000000000000000000000000000f1',
});

/** Sends the member to the Passport, and has it send them back with a code, as it does once they allow. */
async function signIn(): Promise<{ pending: PendingPassportSignIn; callback: URL }> {
  const { url, pending } = await startPassportSignIn(settings(), REDIRECT_URI, '/p/42');
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    nonce: url.searchParams.get('nonce')!,
    challenge: url.searchParams.get('code_challenge')!,
    redirectUri: url.searchParams.get('redirect_uri')!,
  });
  const callback = new URL(REDIRECT_URI);
  callback.search = new URLSearchParams({ code, state: url.searchParams.get('state')! }).toString();
  return { pending, callback };
}

describe('Community Passport sign-in', () => {
  it('sends the member to the Passport with PKCE, state and nonce, for this client', async () => {
    const { url, pending } = await startPassportSignIn(settings(), REDIRECT_URI, '/p/42');
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    });
    expect(pending.returnTo).toBe('/p/42');
  });

  it('swaps the code for an ID token, with HTTP Basic and the verifier, and returns the Account', async () => {
    const { pending, callback } = await signIn();
    expect(await finishPassportSignIn(settings(), pending, callback)).toBe(getAddress(ACCOUNT));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.body.get('code_verifier')).toBe(pending.verifier);
    expect(tokenRequests[0]!.body.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('refuses a callback for another sign-in (state)', async () => {
    const { pending, callback } = await signIn();
    callback.searchParams.set('state', 'someone-elses');
    await expect(finishPassportSignIn(settings(), pending, callback)).rejects.toThrow();
    expect(tokenRequests).toHaveLength(0);
  });

  it.each([
    ['for another sign-in (nonce)', { nonce: 'replayed' }],
    ['for another app (audience)', { aud: 'another-club' }],
    ['from another issuer', { iss: 'https://not-the-passport.example' }],
    ['that expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('refuses an ID token %s', async (_, override) => {
    const base = issue;
    issue = (request) => ({ ...base(request), ...override });
    const { pending, callback } = await signIn();
    await expect(finishPassportSignIn(settings(), pending, callback)).rejects.toThrow();
  });

  it('refuses an ID token the Passport did not sign', async () => {
    signWith = signingKey().privateKey;
    const { pending, callback } = await signIn();
    await expect(finishPassportSignIn(settings(), pending, callback)).rejects.toThrow();
  });

  it('refuses an ID token that names no Lens Account', async () => {
    const base = issue;
    issue = (request) => ({ ...base(request), sub: 'member-42' });
    const { pending, callback } = await signIn();
    const error = await finishPassportSignIn(settings(), pending, callback).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
  });

  it('refuses plain HTTP to a Passport that is not on this machine', async () => {
    const remote = { ...settings(), issuer: 'http://passport.example' };
    await expect(startPassportSignIn(remote, REDIRECT_URI, '/')).rejects.toThrow();
  });
});

describe('where a sign-in comes back to', () => {
  it.each([
    [null, '/'],
    ['/', '/'],
    ['/p/42?reply=1', '/p/42?reply=1'],
    ['//evil.example/phish', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['/ok\r\nSet-Cookie: x=1', '/'],
  ])('%s becomes %s', (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });
});

describe('Passport settings', () => {
  it('reads its bootstrap variables, and refuses a zero address', () => {
    const config = resolveConfig(
      {},
      {
        PASSPORT_ISSUER: 'https://passport.example',
        PASSPORT_CLIENT_ID: CLIENT_ID,
        PASSPORT_GRANT_REGISTRY: '0x00000000000000000000000000000000000000a1',
        CLUB_FORWARDER_ADDRESS: '0x00000000000000000000000000000000000000f1',
      }
    );
    expect(config).toMatchObject({
      passportIssuer: 'https://passport.example',
      passportClientId: CLIENT_ID,
      grantRegistry: '0x00000000000000000000000000000000000000a1',
      clubForwarder: '0x00000000000000000000000000000000000000f1',
    });
    expect(() =>
      resolveConfig({}, { CLUB_FORWARDER_ADDRESS: '0x0000000000000000000000000000000000000000' })
    ).toThrow(/CLUB_FORWARDER_ADDRESS/);
  });

  it('tells browsers where the Passport is only once sign-in through it works', () => {
    const config = InstanceConfig.parse({ passportIssuer: 'https://passport.example' });
    expect(publicConfig(config)).toMatchObject({ passportEnabled: false, passportIssuer: '' });
    expect(publicConfig(config, '', false, true)).toMatchObject({
      passportEnabled: true,
      passportIssuer: 'https://passport.example',
    });
  });
});
