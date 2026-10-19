import { NextResponse } from 'next/server';
import { parseEther } from 'viem';
import { isSponsorshipAvailable } from '@/lib/server/guard';
import { checkHealth } from '@/lib/server/health';

export const dynamic = 'force-dynamic';

// Enough for a few sign-ups (~0.25 MON each at 102 gwei): below it, a relayer can't be counted on.
const MIN_RELAYER_BALANCE = parseEther('1');

/**
 * Whether the app pays network fees right now: set up to, and every relayer allowlisted on the SponsorRouter and
 * funded. When it doesn't, the client sends actions from the user's wallet instead of having them refused.
 */
export async function GET() {
  let available = isSponsorshipAvailable();
  if (available) {
    const { relayers } = await checkHealth();
    available =
      relayers.length > 0 &&
      relayers.every(
        (relayer) =>
          relayer.allowlisted === true &&
          relayer.balance !== null &&
          parseEther(relayer.balance) >= MIN_RELAYER_BALANCE
      );
  }
  return NextResponse.json({ available }, { headers: { 'cache-control': 'no-store' } });
}
