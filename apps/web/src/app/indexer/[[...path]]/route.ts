import { proxyIndexer } from '@/lib/server/indexer-proxy';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return proxyIndexer(request, (await context.params).path ?? []);
}
export const HEAD = GET;
