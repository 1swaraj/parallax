import { NextResponse } from 'next/server';
import { publicConfig } from '@/lib/instance-schema';
import { getInstanceConfig } from '@/lib/server/instance-config';
import { getSecret } from '@/lib/server/secrets';
import { handle } from '@/lib/server/guard';
export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    const config = await getInstanceConfig();
    return NextResponse.json(
      publicConfig(
        config,
        (await getSecret('walletConnectProjectId')) ?? '',
        !!process.env.DATABASE_URL &&
          !!process.env.INSTANCE_SECRET &&
          config.userEmailEnabled &&
          !!config.appUrl &&
          !!config.emailFrom &&
          !!(await getSecret('resendApiKey'))
      ),
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
