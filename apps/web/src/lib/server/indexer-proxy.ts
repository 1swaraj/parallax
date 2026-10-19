import { getInstanceConfig } from './instance-config';

const HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
export async function proxyIndexer(
  request: Request,
  path: string[],
  send: typeof fetch = fetch
): Promise<Response> {
  const { indexerUrl } = await getInstanceConfig();
  if (!indexerUrl)
    return Response.json({ error: 'The indexer is not configured yet' }, { status: 503 });
  // Encode segments independently: a path cannot replace the configured origin or traverse its base path.
  if (
    path.some((part) => part === '.' || part === '..' || part.includes('/') || part.includes('\\'))
  )
    return new Response(null, { status: 400 });
  const url = `${indexerUrl.replace(/\/+$/, '')}/${path.map(encodeURIComponent).join('/')}${new URL(request.url).search}`;
  const headers = new Headers();
  for (const name of [
    'accept',
    'accept-language',
    'if-none-match',
    'if-modified-since',
    'range',
    'if-range',
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('accept-encoding', 'identity');
  try {
    const upstream = await send(url, {
      method: request.method,
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of [...HOP_HEADERS, 'set-cookie', 'content-encoding', 'content-length'])
      responseHeaders.delete(name);
    // Upstream redirects must not send readers to a private indexer URL.
    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304)
      return new Response(null, { status: 502 });
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { error: 'The indexer did not respond' },
      { status: request.signal.aborted ? 499 : 504 }
    );
  }
}
