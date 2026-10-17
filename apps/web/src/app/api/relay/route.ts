import { sponsorRouterAbi } from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { isAddress, isAddressEqual, isHex, type Address, type Hex } from 'viem';
import { contracts } from '@/lib/config';
import { sendAsRelayer } from '@/lib/server/chain';
import { assertNotPaused, assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';
import { sponsoredAccount } from '@/lib/server/sponsor';

// Simulation, the relayer's turn and the receipt fit well within a minute; sendAsRelayer gives up on the receipt first.
export const maxDuration = 60;

// The primitives the SponsorRouter allowlists at launch. The router enforces the functions; this only gives a clear
// error, and keeps the relayer from paying for simulations of anything else.
const SPONSORED_TARGETS = [
  contracts.LensGlobalFeed,
  contracts.LensGlobalGraph,
  contracts.LensGlobalNamespace,
  contracts.AccountBlockingRule,
];

// ~1,000 characters of inline post metadata, plus the encoding.
const MAX_CALLDATA_BYTES = 8 * 1024;

/**
 * Relays a call for the session's Account: SponsorRouter.execute(account, target, data). The primitives check that
 * the Account itself is the author, follower or blocker, so a session can only act for its own Account.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertNotPaused();
    assertSameOrigin(request);
    const { target, data } = (await request.json()) as { target?: string; data?: string };
    if (
      !target ||
      !isAddress(target) ||
      !SPONSORED_TARGETS.some((allowed) => isAddressEqual(allowed, target))
    ) {
      throw new HttpError(400, "That action can't be sponsored");
    }
    if (!data || !isHex(data) || (data.length - 2) / 2 > MAX_CALLDATA_BYTES) {
      throw new HttpError(400, 'Invalid or oversized call');
    }
    const account = await sponsoredAccount(await getSession());
    const { hash, blockNumber } = await sendAsRelayer(
      {
        address: contracts.SponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'execute',
        args: [account, target as Address, data as Hex],
      },
      account
    );
    return NextResponse.json({ hash, blockNumber: blockNumber.toString() });
  });
}
