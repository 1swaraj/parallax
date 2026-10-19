import fs from 'node:fs';
import path from 'node:path';
import { getInstanceConfig } from '@/lib/server/instance-config';
export const dynamic = 'force-dynamic';
export async function GET() {
  const config = await getInstanceConfig();
  if (config.iconUrl) return Response.redirect(config.iconUrl, 307);
  const svg = fs
    .readFileSync(path.join(process.cwd(), 'src/lib/default-icon.svg'), 'utf8')
    .replaceAll('#6e54ff', config.accentColor)
    .replaceAll('#6E54FF', config.accentColor);
  return new Response(svg, {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=10' },
  });
}
