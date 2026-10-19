import { NextResponse } from 'next/server';
import { isAddress, type Address } from 'viem';
import { accountsOwnedBy } from '@/lib/server/accounts';
import { isOwnedBy } from '@/lib/server/chain';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { recordDirectSignup } from '@/lib/server/signups';
import { getSession } from '@/lib/server/session';

export async function GET() {
  return handle(async () => {
    const session = await getSession();
    // Signed in without an account: one may have been created since (e.g. from the wallet), so look again.
    if (session.owner && !session.account) {
      const [found] = await accountsOwnedBy(session.owner).catch(() => []);
      if (found) {
        session.account = found;
        await session.save();
      }
    }
    return NextResponse.json(
      { owner: session.owner ?? null, account: session.account ?? null },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}

/** Switches to another Account the signed-in owner owns. */
export async function PUT(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await getSession();
    const { account, signup } = (await request.json()) as { account?: string; signup?: boolean };
    if (!session.owner) {
      throw new HttpError(401, 'Sign in first');
    }
    if (!account || !isAddress(account) || !(await isOwnedBy(account as Address, session.owner))) {
      throw new HttpError(403, "You don't own that account");
    }
    session.account = account as Address;
    await session.save();
    if (signup === true)
      await recordDirectSignup(session.account).catch(() =>
        console.error('Could not record wallet-paid signup statistics')
      );
    return NextResponse.json({
      owner: session.owner,
      account: session.account,
      accounts: await accountsOwnedBy(session.owner),
    });
  });
}

export async function DELETE(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await getSession();
    session.destroy();
    return NextResponse.json({ owner: null, account: null });
  });
}
