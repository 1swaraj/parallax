// What a signed-in member may do (lib/server/member.ts, sponsoredMember in sponsor.ts): a wallet session through the
// SponsorRouter as before, a Community Passport session only within its live grant.

import { passportRelayAbi } from '@lens-monad/protocol';
import { ContractFunctionRevertedError, encodeErrorResult, type Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getEmail } from '../src/app/api/email/route';
import { contracts } from '../src/lib/config';
import { isOwnedBy, isSponsored, publicClient } from '../src/lib/server/chain';
import { HttpError } from '../src/lib/server/guard';
import { passportRevert, signedInMember } from '../src/lib/server/member';
import { passportSettings } from '../src/lib/server/passport';
import { getSession } from '../src/lib/server/session';
import { sponsoredMember } from '../src/lib/server/sponsor';
import { randomAddress } from './helpers';

vi.mock('../src/lib/server/chain', () => ({
  publicClient: { readContract: vi.fn() },
  isOwnedBy: vi.fn(),
  isSponsored: vi.fn(),
}));
vi.mock('../src/lib/server/moderation', () => ({
  assertSponsorPolicy: vi.fn(async () => {}),
  moderationSnapshot: vi.fn(),
}));
vi.mock('../src/lib/server/passport', () => ({ passportSettings: vi.fn() }));
vi.mock('../src/lib/server/session', () => ({ getSession: vi.fn() }));

const SETTINGS = {
  issuer: 'https://passport.example',
  clientId: 'club',
  clientSecret: 'secret',
  registry: randomAddress(),
  forwarder: randomAddress(),
};
const now = () => BigInt(Math.floor(Date.now() / 1000));
let grantExpiry: bigint;
let allowed: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(passportSettings).mockResolvedValue(SETTINGS);
  grantExpiry = now() + 86_400n;
  allowed = true;
  vi.mocked(publicClient.readContract).mockImplementation((async ({
    functionName,
    args,
  }: {
    functionName: string;
    args: readonly unknown[];
  }) => {
    // Grants are this community's forwarder's, nobody else's.
    if ((args[1] as Address) !== SETTINGS.forwarder) throw new Error('asked about another grantee');
    if (functionName === 'grantOf') return ['0x' + '11'.repeat(32), grantExpiry];
    if (functionName === 'isAllowed') return allowed;
    throw new Error(`unexpected read ${functionName}`);
  }) as never);
});

const post = { target: contracts.LensGlobalFeed, data: '0x12345678abcd' as const };

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('a Community Passport session', () => {
  const session = () => ({
    via: 'passport' as const,
    account: randomAddress(),
    holder: randomAddress(),
  });

  it('acts within its live grant, known to moderation by the Account owner it signed in with', async () => {
    const signedIn = session();
    const member = await sponsoredMember(signedIn, post);
    expect(member).toEqual({
      account: signedIn.account,
      owner: signedIn.holder,
      passport: SETTINGS,
    });
  });

  it('is signed out once the grant ended or ran out, and told to sign in again', async () => {
    grantExpiry = 0n;
    const error = await refusal(sponsoredMember(session(), post));
    expect(error.status).toBe(401);
    expect(error.details).toEqual({ reauth: true });
  });

  it('is refused a call outside its grant, and told to sign in again to review it', async () => {
    allowed = false;
    const error = await refusal(sponsoredMember(session(), post));
    expect(error.status).toBe(403);
    expect(error.details).toEqual({ reauth: true });
  });

  it('is never sponsored through the SponsorRouter, e.g. for a profile', async () => {
    expect((await refusal(sponsoredMember(session()))).status).toBe(403);
    expect(isSponsored).not.toHaveBeenCalled();
  });

  it('manages email digests only while its grant is live', async () => {
    vi.mocked(getSession).mockResolvedValue(session() as never);
    grantExpiry = 0n;
    const response = await getEmail();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reauth: true });
  });

  it('needs its Account and holder, and the Passport still set up', async () => {
    expect(
      (await refusal(signedInMember({ via: 'passport', account: randomAddress() }))).status
    ).toBe(401);
    vi.mocked(passportSettings).mockResolvedValue(null);
    expect((await refusal(signedInMember(session()))).status).toBe(401);
  });
});

describe('a wallet session', () => {
  const session = () => ({ owner: randomAddress(), account: randomAddress() });

  it('needs the wallet to still own the Account, and the router as its manager', async () => {
    vi.mocked(isOwnedBy).mockResolvedValue(false);
    expect((await refusal(sponsoredMember(session(), post))).status).toBe(403);
    vi.mocked(isOwnedBy).mockResolvedValue(true);
    vi.mocked(isSponsored).mockResolvedValue(false);
    expect((await refusal(sponsoredMember(session(), post))).status).toBe(403);
    vi.mocked(isSponsored).mockResolvedValue(true);
    const signedIn = session();
    expect(await sponsoredMember(signedIn, post)).toEqual({
      account: signedIn.account,
      owner: signedIn.owner,
      passport: null,
    });
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });
});

describe('a reverted call through the forwarder', () => {
  const reverted = (errorName: 'GrantNotActive' | 'NotInScope' | 'RegistryPaused' | 'NotRelayer') =>
    new ContractFunctionRevertedError({
      abi: passportRelayAbi,
      data: encodeErrorResult({ abi: passportRelayAbi, errorName }),
      functionName: 'execute',
    });

  it.each([
    ['GrantNotActive', 401, true],
    ['NotInScope', 403, true],
    ['RegistryPaused', 503, false],
    ['NotRelayer', 503, false],
  ] as const)('%s says %i', (name, status, reauth) => {
    const error = passportRevert(reverted(name));
    expect(error?.status).toBe(status);
    expect(error?.details?.reauth === true).toBe(reauth);
  });

  it("leaves other errors, e.g. Lens', to the usual handling", () => {
    expect(passportRevert(new Error('boom'))).toBeNull();
  });
});
