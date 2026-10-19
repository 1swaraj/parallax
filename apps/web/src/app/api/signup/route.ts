import { getSponsorshipConfig } from '@/lib/server/sponsorship-config';
import {
  accountFactoryAbi,
  createAccountWithUsernameArgs,
  lensFactoryAbi,
  usernameError,
} from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { authorizeSignup, registerMember, moderationSnapshot } from '@/lib/server/moderation';
import { currentConfig } from '@/lib/server/instance-config';
import { isAddressEqual, parseEventLogs, type Address, type Log } from 'viem';
import { runtimeContracts as contracts } from '@/lib/server/contracts';
import { sendAsRelayer } from '@/lib/server/chain';
import { maxGasPerSignUp, numberEnv } from '@/lib/server/env';
import {
  assertSameOrigin,
  assertSponsorshipAvailable,
  handle,
  HttpError,
} from '@/lib/server/guard';
import { clientIpKey, profileMetadataURI } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { rateLimit } from '@/lib/server/state';

export const maxDuration = 60;

const HOUR_MS = 60 * 60 * 1000;

/** Admission for wallet-paid creation; membership is recorded only after ownership/creation checks. */
export async function PUT(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const { owner } = await getSession();
    if (!owner) throw new HttpError(401, 'Sign in first');
    await rateLimit(`admission:${owner}`, 10, HOUR_MS);
    await authorizeSignup(owner, await request.json(), request);
    return NextResponse.json({ admitted: true }, { headers: { 'cache-control': 'no-store' } });
  });
}

export async function GET() {
  return handle(async () => {
    const policy = currentConfig().moderation;
    return NextResponse.json(
      {
        signupMode: policy.signupMode,
        turnstileEnabled: policy.turnstileEnabled,
        turnstileSiteKey: policy.turnstileSiteKey,
        token: policy.signupMode === 'token' ? policy.token : null,
        sponsorship: policy.sponsorship,
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}

/** The Account the sign-up created, from AccountFactory's event: one per sign-up. */
function createdAccount(logs: Log[]): Address {
  const [created] = parseEventLogs({
    abi: accountFactoryAbi,
    eventName: 'Lens_Account_Created',
    logs: logs.filter((log) => isAddressEqual(log.address, contracts.AccountFactory)),
  });
  if (!created) {
    throw new Error('The sign-up created no Account');
  }
  return created.args.account;
}

/**
 * Creates a Lens Account for the signed-in EOA, paid by the relayer: LensFactory.createAccountWithUsernameFree, with
 * the EOA as owner and the SponsorRouter as manager. Sign-ups are the most expensive sponsored action (~2.1M gas),
 * so they are rate-limited per owner, per IP and overall.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSponsorshipAvailable();
    assertSameOrigin(request);
    const session = await getSession();
    if (!session.owner) {
      throw new HttpError(401, 'Sign in first');
    }
    const body = (await request.json()) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username : '';
    const invalid = usernameError(username);
    if (invalid) {
      throw new HttpError(400, `Username: ${invalid}`);
    }
    const metadataURI = profileMetadataURI(body);
    // EOAs are free to create, and IPs (IPv6 /64s above all) cheap to rotate: per owner and per IP, then overall. The
    // overall cap comes last, so requests the others refuse don't use it up.
    await rateLimit(`signup:${session.owner}`, numberEnv('SIGNUP_RATE_LIMIT_PER_HOUR', 3), HOUR_MS);
    await rateLimit(
      `signup-ip:${clientIpKey(request)}`,
      numberEnv('SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR', 10),
      HOUR_MS
    );
    const policy = currentConfig().moderation;
    if (
      policy.sponsorship === 'nobody' ||
      (policy.sponsorship === 'approved' &&
        !(await moderationSnapshot()).accounts.get(session.owner.toLowerCase())?.approved)
    )
      throw new HttpError(
        403,
        'This instance does not sponsor this sign-up. You can pay from your wallet.'
      );
    await authorizeSignup(session.owner, body, request);
    await rateLimit('signup-all', numberEnv('SPONSOR_SIGNUPS_PER_HOUR', 200), HOUR_MS);

    // The Account doesn't exist yet: the owner picks the relayer.
    const { hash, logs, blockNumber } = await sendAsRelayer(
      {
        address: contracts.LensFactory,
        abi: lensFactoryAbi,
        functionName: 'createAccountWithUsernameFree',
        args: createAccountWithUsernameArgs({
          namespace: contracts.LensGlobalNamespace,
          owner: session.owner,
          username,
          metadataURI,
          sponsorRouter: (await getSponsorshipConfig()).sponsorRouter,
        }),
      },
      session.owner,
      maxGasPerSignUp()
    );
    session.account = createdAccount(logs);
    await registerMember(session.account, session.owner);
    await session.save();
    return NextResponse.json({
      account: session.account,
      hash,
      blockNumber: blockNumber.toString(),
    });
  });
}
