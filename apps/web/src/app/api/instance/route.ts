import { NextResponse } from 'next/server';
import { handle } from '@/lib/server/guard';
import { getSponsorshipConfig } from '@/lib/server/sponsorship-config';

/** Public settings only. Never expose the full instance config or its secrets. */
export async function GET() {
  return handle(async () =>
    NextResponse.json(await getSponsorshipConfig(), {
      headers: { 'cache-control': 'no-store' },
    })
  );
}
