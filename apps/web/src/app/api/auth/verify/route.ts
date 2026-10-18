import { NextResponse } from 'next/server';
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import { CHAIN_ID } from '@/lib/config';
import { accountsOwnedBy } from '@/lib/server/accounts';
import { publicClient } from '@/lib/server/chain';
import { appUrl } from '@/lib/server/env';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { getSession, isFreshSignIn } from '@/lib/server/session';

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
    // The app's URL when it's set: the Host and X-Forwarded-Host headers say whatever the request says.
    const domain =
      appUrl()?.host ?? request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    const fields = parseSiweMessage(message);
    if (!domain || !session.nonce || fields.chainId !== CHAIN_ID || !fields.address) {
      throw new HttpError(400, 'Invalid sign-in request, try again.');
    }
    if (!isFreshSignIn(session.nonceAt, fields.issuedAt)) {
      throw new HttpError(400, 'This sign-in request expired, try again.');
    }
    const valid = await verifySiweMessage(publicClient, {
      message,
      signature,
      domain,
      nonce: session.nonce,
    });
    // A nonce is good for one attempt.
    session.nonce = undefined;
    session.nonceAt = undefined;
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
