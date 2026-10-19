import { getSponsorshipConfig } from '@/lib/server/sponsorship-config';
import { EMPTY_SOURCE_STAMP, sponsorRouterAbi } from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { sendAsRelayer } from '@/lib/server/chain';
import { maxGasPerTransaction } from '@/lib/server/env';
import { assertSameOrigin, assertSponsorshipAvailable, handle } from '@/lib/server/guard';
import { profileMetadataURI } from '@/lib/server/requests';
import { getSession } from '@/lib/server/session';
import { sponsoredAccount, assertTextAllowed } from '@/lib/server/sponsor';

export const maxDuration = 60;

/** Updates the session Account's default profile through SponsorRouter.setMetadataURI, with no app's source stamp. */
export async function POST(request: Request) {
  return handle(async () => {
    assertSponsorshipAvailable();
    assertSameOrigin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const metadataURI = profileMetadataURI(body);
    await assertTextAllowed(`${body.name ?? ''}\n${body.bio ?? ''}\n${body.picture ?? ''}`);
    const account = await sponsoredAccount(await getSession());
    const { hash, blockNumber } = await sendAsRelayer(
      {
        address: (await getSponsorshipConfig()).sponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'setMetadataURI',
        args: [account, metadataURI, EMPTY_SOURCE_STAMP],
      },
      account,
      maxGasPerTransaction()
    );
    return NextResponse.json({ hash, blockNumber: blockNumber.toString() });
  });
}
