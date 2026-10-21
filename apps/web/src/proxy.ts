import { NextResponse, type NextRequest } from 'next/server';
import { MIRROR } from './lib/config';
import { currentConfig, getInstanceConfig } from './lib/server/instance-config';
import { settingUpPage } from './lib/server/setting-up-page';
import { setupStatus } from './lib/server/setup';

/** What writes Lens, or the app's own likes and digests: a mirror's client takes none of it. */
const MIRROR_WRITES = /^\/api\/(relay|signup|profile|likes|email)\/?$/;

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (MIRROR && request.method !== 'GET' && request.method !== 'HEAD' && MIRROR_WRITES.test(path))
    return NextResponse.json(
      {
        error:
          'This is a read-only mirror of Lens. To post, follow or like, use a Lens app on Lens Chain.',
      },
      { status: 403, headers: { 'cache-control': 'no-store' } }
    );
  if (
    path.startsWith('/setup') ||
    path.startsWith('/admin') ||
    path.startsWith('/api/admin') ||
    path.startsWith('/api/setup') ||
    path.startsWith('/api/auth/') ||
    path === '/api/config' ||
    path === '/api/health' ||
    path.startsWith('/indexer/') ||
    path.startsWith('/api/email/')
  )
    return NextResponse.next();
  const status = await setupStatus();
  if (status.completed) return NextResponse.next();
  const headers = { 'cache-control': 'no-store', 'retry-after': '10' };
  if (path.startsWith('/api/'))
    return NextResponse.json(
      { error: 'This instance is being set up. Please check back soon.' },
      { status: 503, headers }
    );
  const config = await getInstanceConfig().catch(() => currentConfig());
  return new NextResponse(settingUpPage(config), {
    status: 503,
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
  });
}
export const config = { matcher: ['/((?!_next/|icon|opengraph-image|favicon.ico).*)'] };
