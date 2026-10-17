import { NextResponse } from 'next/server';
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import { CHAIN_ID } from '@/lib/config';
import { accountsOwnedBy } from '@/lib/server/accounts';
import { publicClient } from '@/lib/server/chain';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { getSession } from '@/lib/server/session';

/** Signs in with Ethereum (EIP-4361), then picks the first Lens Account the signer owns. */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const { message, signature } = (await request.json()) as {
      message?: string;
      signature?: `0x${string}`;
    };
    if (typeof message !== 'string' || typeof signature !== 'string') {
      throw new HttpError(400, 'message and signature are required');
    }
    const session = await getSession();
    const domain = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
    const fields = parseSiweMessage(message);
    if (!session.nonce || fields.chainId !== CHAIN_ID || !fields.address) {
      throw new HttpError(400, 'Invalid sign-in request, try again.');
    }
    const valid = await verifySiweMessage(publicClient, {
      message,
      signature,
      domain,
      nonce: session.nonce,
    });
    // A nonce is good for one attempt.
    session.nonce = undefined;
    if (!valid) {
      await session.save();
      throw new HttpError(401, 'Invalid signature');
    }
    const accounts = await accountsOwnedBy(fields.address);
    session.owner = fields.address;
    session.account = accounts[0];
    await session.save();
    return NextResponse.json({ owner: session.owner, account: session.account ?? null, accounts });
  });
}
