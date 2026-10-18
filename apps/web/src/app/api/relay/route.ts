import { feedAbi, sponsorRouterAbi } from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { isAddress, isHex, parseEventLogs, type Address, type Hex } from 'viem';
import { contracts } from '@/lib/config';
import { sendAsRelayer } from '@/lib/server/chain';
import { maxGasPerTransaction } from '@/lib/server/env';
import {
  assertSameOrigin,
  assertSponsorshipAvailable,
  handle,
  HttpError,
} from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';
import { assertSponsoredCall, sponsoredAccount } from '@/lib/server/sponsor';

// Simulation, the relayer's turn and the receipt fit well within a minute; sendAsRelayer gives up on the receipt first.
export const maxDuration = 60;

// ~1,000 characters of inline post metadata, plus the encoding.
const MAX_CALLDATA_BYTES = 8 * 1024;

/**
 * Relays a call for the session's Account: SponsorRouter.execute(account, target, data), for the calls the app makes
 * (assertSponsoredCall). The primitives check that the Account itself is the author, follower or blocker, so a
 * session can only act for its own Account.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSponsorshipAvailable();
    assertSameOrigin(request);
    const { target, data } = (await request.json()) as { target?: string; data?: string };
    if (!target || !isAddress(target)) {
      throw new HttpError(400, "That action can't be sponsored");
    }
    if (!data || !isHex(data) || (data.length - 2) / 2 > MAX_CALLDATA_BYTES) {
      throw new HttpError(400, 'Invalid or oversized call');
    }
    assertSponsoredCall(target, data);
    const account = await sponsoredAccount(await getSession());
    const { hash, blockNumber, logs } = await sendAsRelayer(
      {
        address: contracts.SponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'execute',
        args: [account, target as Address, data as Hex],
      },
      account,
      maxGasPerTransaction()
    );
    // The post a createPost made, so the client can link to it without reading the receipt from its own RPC.
    const [created] = parseEventLogs({ abi: feedAbi, eventName: 'Lens_Feed_PostCreated', logs });
    return NextResponse.json({
      hash,
      blockNumber: blockNumber.toString(),
      postId: created ? created.args.postId.toString() : null,
    });
  });
}
