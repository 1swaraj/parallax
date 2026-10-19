import { NextResponse } from 'next/server';
import { equalToken, tokenHash } from '@/lib/server/setup';
import { handle, HttpError } from '@/lib/server/guard';
import { runOperatorAlerts, runDigests } from '@/lib/server/notifications-email';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  return handle(async () => {
    const secret = process.env.CRON_SECRET;
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secret || !token || !equalToken(token, tokenHash(secret)))
      throw new HttpError(404, 'Not found');
    await runOperatorAlerts();
    return NextResponse.json(await runDigests(), { headers: { 'cache-control': 'no-store' } });
  });
}
