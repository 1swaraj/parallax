import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// Fetches a URL from someone else's metadata, e.g. a post's https:// contentURI, from the indexer's server: the URL
// is anyone's choice, so the server must not reach what isn't public (SSRF). Only https, to public unicast addresses
// only, which the connection is pinned to, so DNS can't answer differently between the check and the connection; each
// redirect is checked again; responses are capped in size and time.

const PRIVATE_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  PRIVATE_IPV4.addSubnet(network, prefix, 'ipv4');
}

// IPv6: global unicast only (2000::/3), which leaves out loopback, unique local, link-local, multicast and the IPv4
// mapped and translated ranges, less what IANA reserves inside it.
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');
const RESERVED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23], // IETF protocol assignments, Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which embeds an IPv4 address
  ['3fff::', 20], // documentation
] as const) {
  RESERVED_IPV6.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address` is a public unicast IP: what a server may connect to for someone else's URL. */
export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !PRIVATE_IPV4.check(address, 'ipv4');
    case 6:
      return GLOBAL_IPV6.check(address, 'ipv6') && !RESERVED_IPV6.check(address, 'ipv6');
    default:
      return false;
  }
}

export class FetchRefused extends Error {}

export type PublicFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  // For tests: how names resolve, which addresses are reachable, and the transport.
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  isAllowed?: (address: string) => boolean;
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void
  ) => ClientRequest;
};

const agent = new Agent({ keepAlive: true, maxSockets: 32, timeout: 10_000 });

/** The address to connect to: every address the name has must be public, or none is used. */
async function pinnedAddress(
  hostname: string,
  {
    resolve = (name) => dnsLookup(name, { all: true, verbatim: true }),
    isAllowed = isPublicAddress,
  }: PublicFetchOptions
): Promise<LookupAddress> {
  const literal = hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = isIP(literal)
    ? [{ address: literal, family: isIP(literal) }]
    : await resolve(hostname).catch(() => []);
  if (addresses.length === 0 || !addresses.every((entry) => isAllowed(entry.address))) {
    throw new FetchRefused(`${hostname} doesn't resolve to public addresses only`);
  }
  return addresses[0]!;
}

function get(
  url: URL,
  pinned: LookupAddress,
  options: PublicFetchOptions,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) =>
    lookupOptions.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family);
  return new Promise((resolve, reject) => {
    const request = (options.request ?? httpsRequest)(
      {
        hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: 'application/json, */*;q=0.5', 'user-agent': 'Parallax indexer' },
        lookup,
        agent: options.request ? undefined : agent,
        signal,
      },
      resolve
    );
    request.on('error', reject);
    request.end();
  });
}

function read(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new FetchRefused(`The response is over ${maxBytes} bytes`));
      response.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new FetchRefused(`The response is over ${maxBytes} bytes`));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
    response.on('aborted', () => reject(new Error('The response was cut off')));
  });
}

/** GETs a public https URL's body, following up to `maxRedirects` redirects, each checked like the URL. */
export async function fetchPublic(
  url: string,
  options: PublicFetchOptions
): Promise<{ body: Buffer; contentType: string | null }> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  let current = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== 'https:' || current.username || current.password) {
      throw new FetchRefused(`Only plain https URLs are fetched: ${current.protocol}`);
    }
    const pinned = await pinnedAddress(current.hostname, options);
    const response = await get(current, pinned, options, signal);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && location) {
      response.resume();
      if (redirects >= (options.maxRedirects ?? 3)) {
        throw new FetchRefused('Too many redirects');
      }
      current = new URL(location, current);
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode}`);
    }
    return {
      body: await read(response, options.maxBytes),
      contentType: response.headers['content-type'] ?? null,
    };
  }
}
