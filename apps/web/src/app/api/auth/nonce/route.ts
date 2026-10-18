import { NextResponse } from 'next/server';
import { generateSiweNonce } from 'viem/siwe';
import { handle } from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';

export async function GET() {
  return handle(async () => {
    const session = await getSession();
    session.nonce = generateSiweNonce();
    session.nonceAt = Date.now();
    await session.save();
    return NextResponse.json(
      { nonce: session.nonce },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
