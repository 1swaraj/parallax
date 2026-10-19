import { NextResponse } from 'next/server';
import { requireAdmin, adminDatabase } from '@/lib/server/admin';
import { assertSameOrigin, handle } from '@/lib/server/guard';
import {
  getInstanceConfig,
  writeConfig,
  invalidateInstanceConfig,
} from '@/lib/server/instance-config';
import { CONFIG_ENV } from '@/lib/instance-schema';
export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    await requireAdmin('config');
    return NextResponse.json(
      {
        config: await getInstanceConfig(),
        overrides: Object.entries(CONFIG_ENV)
          .filter(([, keys]) => keys.some((key) => !!process.env[key]))
          .map(([key]) => key),
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
export async function PUT(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin('config');
    assertSameOrigin(request);
    const input = await request.json();
    await adminDatabase().begin(async (tx) => {
      await writeConfig(tx, input, admin.address);
    });
    invalidateInstanceConfig();
    return NextResponse.json(
      { config: await getInstanceConfig() },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
