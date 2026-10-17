import {
  accountFactoryAbi,
  createAccountWithUsernameArgs,
  lensFactoryAbi,
  usernameError,
} from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { isAddressEqual, parseEventLogs, type Address, type Log } from 'viem';
import { contracts } from '@/lib/config';
import { sendAsRelayer } from '@/lib/server/chain';
import { numberEnv } from '@/lib/server/env';
import { assertNotPaused, assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { profileMetadataURI } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { rateLimit } from '@/lib/server/state';

export const maxDuration = 60;

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
 * so they are rate-limited per owner.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertNotPaused();
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
    // EOAs are free to create, so the per-owner limit alone doesn't bound what the relayer spends: limit per IP too.
    // x-forwarded-for is only trustworthy behind a proxy that sets it (e.g. Vercel).
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    await rateLimit(
      `signup:${session.owner}`,
      numberEnv('SIGNUP_RATE_LIMIT_PER_HOUR', 3),
      60 * 60 * 1000
    );
    if (ip) {
      await rateLimit(
        `signup-ip:${ip}`,
        numberEnv('SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR', 10),
        60 * 60 * 1000
      );
    }

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
          metadataURI: profileMetadataURI(body),
          sponsorRouter: contracts.SponsorRouter,
        }),
      },
      session.owner
    );
    session.account = createdAccount(logs);
    await session.save();
    return NextResponse.json({
      account: session.account,
      hash,
      blockNumber: blockNumber.toString(),
    });
  });
}
