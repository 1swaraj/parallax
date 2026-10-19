import { feedAbi, MEDIA_CHUNK_BYTES, sponsorRouterAbi } from '@lens-monad/protocol';
import { NextResponse } from 'next/server';
import { isAddress, isHex, parseEventLogs, type Address, type Hex } from 'viem';
import { currentConfig } from '@/lib/server/instance-config';
import { runtimeContracts as contracts } from '@/lib/server/contracts';
import { sendAsRelayer } from '@/lib/server/chain';
import {
  maxGasPerImagePost,
  maxGasPerMediaChunk,
  maxGasPerTransaction,
  numberEnv,
} from '@/lib/server/env';
import {
  assertSameOrigin,
  assertSponsorshipAvailable,
  handle,
  HttpError,
} from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';
import {
  assertMediaSponsored,
  assertRelayContent,
  assertSponsoredCall,
  isMediaCall,
  sponsoredAccount,
} from '@/lib/server/sponsor';
import { rateLimit } from '@/lib/server/state';

// Simulation, the relayer's turn and the receipt fit well within a minute; sendAsRelayer gives up on the receipt first.
export const maxDuration = 60;

// ~1,000 characters of inline post metadata, plus the encoding. A chunk of an image, plus its arguments.
const MAX_CALLDATA_BYTES = 8 * 1024;
const MAX_MEDIA_CALLDATA_BYTES = MEDIA_CHUNK_BYTES + 256;

const DAY_MS = 24 * 60 * 60 * 1000;

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
      throw new HttpError(400, `${currentConfig().appName} can't pay the fee of that action`);
    }
    const maxBytes = isMediaCall(target) ? MAX_MEDIA_CALLDATA_BYTES : MAX_CALLDATA_BYTES;
    if (!data || !isHex(data) || (data.length - 2) / 2 > maxBytes) {
      throw new HttpError(400, 'Invalid or oversized call');
    }
    const kind = assertSponsoredCall(target, data);
    await assertRelayContent(target, data);
    const account = await sponsoredAccount(await getSession());
    // An image costs ~7 text posts (up to two chunks of ~2.9M gas): a daily allowance per Account, in chunks.
    if (kind === 'media-chunk') {
      await assertMediaSponsored();
      await rateLimit(`media:${account}`, numberEnv('SPONSOR_MEDIA_CHUNKS_PER_DAY', 20), DAY_MS);
    }
    const { hash, blockNumber, logs } = await sendAsRelayer(
      {
        address: contracts.SponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'execute',
        args: [account, target as Address, data as Hex],
      },
      account,
      kind === 'media-chunk'
        ? maxGasPerMediaChunk()
        : kind === 'image-post'
          ? maxGasPerImagePost()
          : maxGasPerTransaction()
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
