import {
  accountFactoryAbi,
  createAccountWithUsernameArgs,
  lensFactoryAbi,
  usernameError,
} from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { database } from '@/lib/server/db';
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
          sponsorRouter: contracts.SponsorRouter,
        }),
      },
      session.owner,
      maxGasPerSignUp()
    );
    session.account = createdAccount(logs);
    await session.save();
    const sql = database();
    if (sql)
      await sql`INSERT INTO lens_web.signups (account) VALUES (${session.account.toLowerCase()}) ON CONFLICT DO NOTHING`;
    return NextResponse.json({
      account: session.account,
      hash,
      blockNumber: blockNumber.toString(),
    });
  });
}
