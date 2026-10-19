import { proxyIndexer } from '@/lib/server/indexer-proxy';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Post images live at /media on the app's origin: the URL their Lens metadata gives other apps.
export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return proxyIndexer(request, ['media', ...((await context.params).path ?? [])]);
}
export const HEAD = GET;
