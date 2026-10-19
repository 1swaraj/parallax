import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/server/admin';
import { assertSameOrigin, handle } from '@/lib/server/guard';
import { InstanceConfig } from '@/lib/instance-schema';
import { checkNetworkSettings } from '@/lib/server/health';
export async function POST(request: Request) {
  return handle(async () => {
    await requireAdmin('config');
    assertSameOrigin(request);
    const config = InstanceConfig.pick({
      publicRpcUrl: true,
      serverRpcUrl: true,
      indexerUrl: true,
    }).parse(await request.json());
    return NextResponse.json(await checkNetworkSettings(config), {
      headers: { 'cache-control': 'no-store' },
    });
  });
}
