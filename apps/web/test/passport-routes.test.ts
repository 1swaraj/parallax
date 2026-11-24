// The Community Passport routes: sign-in (/api/auth/passport and its callback), and relaying for a Passport member
// through the community's ClubForwarder (/api/relay).

import { clubForwarderAbi, createPost, passportRelayAbi } from '@lens-monad/protocol';
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionData,
  zeroHash,
  type Address,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as callback } from '../src/app/api/auth/passport/callback/route';
import { GET as start } from '../src/app/api/auth/passport/route';
import { POST as relay } from '../src/app/api/relay/route';
import { contracts } from '../src/lib/config';
import { ownerOf, sendAsRelayer } from '../src/lib/server/chain';
import { HttpError } from '../src/lib/server/guard';
import { assertAccess } from '../src/lib/server/moderation';
import { finishPassportSignIn, startPassportSignIn } from '../src/lib/server/passport';
import { getSession, type SessionData } from '../src/lib/server/session';
import { sponsoredMember } from '../src/lib/server/sponsor';
import { randomAddress } from './helpers';

vi.mock('../src/lib/server/chain', () => ({ ownerOf: vi.fn(), sendAsRelayer: vi.fn() }));
vi.mock('../src/lib/server/moderation', () => ({
  assertAccess: vi.fn(async () => {}),
  rememberExternalAccount: vi.fn(async () => {}),
  moderationSnapshot: vi.fn(async () => ({ filters: [] })),
}));
vi.mock('../src/lib/server/session', () => ({ getSession: vi.fn() }));
vi.mock('../src/lib/server/passport', async (original) => ({
  ...(await original<typeof import('../src/lib/server/passport')>()),
  requirePassport: vi.fn(async () => SETTINGS),
  startPassportSignIn: vi.fn(),
  finishPassportSignIn: vi.fn(),
}));
vi.mock('../src/lib/server/sponsor', async (original) => ({
  ...(await original<typeof import('../src/lib/server/sponsor')>()),
  sponsoredMember: vi.fn(),
}));

const SETTINGS = {
  issuer: 'https://passport.example',
  clientId: 'club',
  clientSecret: 'secret',
  registry: randomAddress(),
  forwarder: randomAddress(),
};
const APP = 'http://localhost:3000';

type TestSession = SessionData & { save: ReturnType<typeof vi.fn> };
let session: TestSession;

beforeEach(() => {
  vi.clearAllMocks();
  session = { save: vi.fn(async () => {}) };
  vi.mocked(getSession).mockResolvedValue(session as never);
});
afterEach(() => vi.unstubAllEnvs());

describe('signing in through Community Passport', () => {
  it('sends the browser to the Passport and remembers the sign-in, coming back only to this app', async () => {
    const pending = { state: 's', nonce: 'n', verifier: 'v', returnTo: '/', at: Date.now() };
    vi.mocked(startPassportSignIn).mockResolvedValue({
      url: new URL('https://passport.example/auth?client_id=club'),
      pending,
    });
    const response = await start(new Request(`${APP}/api/auth/passport?returnTo=//evil.example`));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://passport.example/auth?client_id=club');
    expect(startPassportSignIn).toHaveBeenCalledWith(
      SETTINGS,
      `${APP}/api/auth/passport/callback`,
      '/'
    );
    expect(session.passport).toBe(pending);
    expect(session.save).toHaveBeenCalled();
  });

  const pending = (at = Date.now()) => ({
    state: 's',
    nonce: 'n',
    verifier: 'v',
    returnTo: '/p/42',
    at,
  });
  const back = (query = '?code=c&state=s') =>
    callback(new Request(`${APP}/api/auth/passport/callback${query}`));
  const signinError = (response: Response) =>
    new URL(response.headers.get('location')!).searchParams.get('signin_error');

  it('signs the member in as the Account the Passport names, with no wallet', async () => {
    const account = randomAddress();
    const holder = randomAddress();
    Object.assign(session, { owner: randomAddress(), passport: pending() });
    vi.mocked(finishPassportSignIn).mockResolvedValue(account);
    vi.mocked(ownerOf).mockResolvedValue(holder);
    const response = await back();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/p/42`);
    // The callback URL the token request is checked against is the registered redirect URI, with the query.
    const callbackUrl = vi.mocked(finishPassportSignIn).mock.calls[0]![2];
    expect(callbackUrl.toString()).toBe(`${APP}/api/auth/passport/callback?code=c&state=s`);
    expect(assertAccess).toHaveBeenCalledWith(holder, account);
    expect(session).toMatchObject({ account, holder, via: 'passport', owner: undefined });
    expect(session.passport).toBeUndefined();
  });

  it('refuses an expired or unknown sign-in, once', async () => {
    Object.assign(session, { passport: pending(Date.now() - 11 * 60 * 1000) });
    const response = await back();
    expect(signinError(response)).toBe('That sign-in expired. Try again.');
    expect(finishPassportSignIn).not.toHaveBeenCalled();
    expect(session.passport).toBeUndefined();
    expect(session.save).toHaveBeenCalled();
  });

  it('says so when the member cancelled on the Passport', async () => {
    Object.assign(session, { passport: pending() });
    const response = await back('?error=access_denied&state=s');
    expect(signinError(response)).toBe('Sign-in was cancelled.');
  });

  it("keeps a member this instance's moderation refuses signed out, and says why", async () => {
    Object.assign(session, { passport: pending() });
    vi.mocked(finishPassportSignIn).mockResolvedValue(randomAddress());
    vi.mocked(ownerOf).mockResolvedValue(randomAddress());
    vi.mocked(assertAccess).mockRejectedValueOnce(new HttpError(403, 'This account is suspended'));
    const response = await back();
    expect(signinError(response)).toBe('This account is suspended');
    expect(session.via).toBeUndefined();
    expect(session.account).toBeUndefined();
  });

  it('does not show the reason of an unexpected failure', async () => {
    Object.assign(session, { passport: pending() });
    vi.mocked(finishPassportSignIn).mockRejectedValue(new Error('internal details'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await back();
    expect(signinError(response)).toBe('Community Passport could not sign you in. Try again.');
  });
});

describe("relaying for a Passport member through the community's forwarder", () => {
  const account = randomAddress();
  const call = createPost(
    contracts.LensGlobalFeed,
    account,
    'data:application/json,{"lens":{"content":"hi"}}'
  );

  const send = () =>
    relay(
      new Request(`${APP}/api/relay`, {
        method: 'POST',
        headers: { origin: APP, host: 'localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify(call),
      })
    );

  beforeEach(() => {
    vi.stubEnv('RELAY_PAUSED', 'false');
    Object.assign(session, { via: 'passport', account, holder: randomAddress() });
    vi.mocked(sponsoredMember).mockResolvedValue({
      account,
      owner: randomAddress(),
      passport: SETTINGS,
    });
  });

  it('sends ClubForwarder.execute(account, target, data) to the forwarder', async () => {
    vi.mocked(sendAsRelayer).mockImplementation(async (sent) => {
      expect(sent.address).toBe(SETTINGS.forwarder);
      const decoded = decodeFunctionData({
        abi: clubForwarderAbi,
        data: encodeFunctionData(sent as never),
      });
      expect(decoded).toEqual({ functionName: 'execute', args: [account, call.target, call.data] });
      return { hash: zeroHash, blockNumber: 7n, logs: [] };
    });
    const response = await send();
    expect(response.status).toBe(200);
    expect(sponsoredMember).toHaveBeenCalledWith(expect.anything(), {
      target: call.target as Address,
      data: call.data,
    });
  });

  it('answers 401 with reauth when the grant ended in the meantime', async () => {
    vi.mocked(sendAsRelayer).mockRejectedValue(
      new ContractFunctionRevertedError({
        abi: passportRelayAbi,
        data: encodeErrorResult({ abi: passportRelayAbi, errorName: 'GrantNotActive' }),
        functionName: 'execute',
      })
    );
    const response = await send();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reauth: true });
  });
});
