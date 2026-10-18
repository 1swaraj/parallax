import { isIP } from 'node:net';
import { accountMetadata, toDataURI } from '@lens-monad/protocol';
import { MAX_BIO_CHARACTERS, MAX_NAME_CHARACTERS } from '../config';
import { HttpError } from './guard';

/**
 * The client's address for per-IP limits, from x-forwarded-for (only trustworthy behind a proxy that sets it, e.g.
 * Vercel). IPv6 clients get a whole /64, so one is grouped by its /64. Requests without a usable address share one
 * bucket, rather than escaping the limit.
 */
export function clientIpKey(request: Request): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const version = isIP(ip);
  if (version === 4) {
    return ip;
  }
  if (version !== 6) {
    return 'unknown';
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) {
    return mapped[1]!;
  }
  // An IPv4 tail is in the last 32 bits, so it never changes the /64: count it as two groups.
  const groups = (part: string) =>
    part ? part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : [];
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${full
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, `${field} must be text of at most ${max} characters`);
  }
  return value;
}

function optionalPicture(value: unknown): string | undefined {
  const picture = optionalText(value, 'picture', 512);
  if (picture && !/^https:\/\/[^\s]+$/.test(picture)) {
    throw new HttpError(400, 'picture must be an https URL');
  }
  return picture;
}

/** A `limit` query parameter: an integer from 1 to `max`, or `fallback` when absent. */
export function pageLimit(value: string | null, fallback: number, max = 100): number {
  if (value === null || value === '') {
    return fallback;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new HttpError(400, `limit must be an integer from 1 to ${max}`);
  }
  return limit;
}

/** An optional ISO 8601 time query parameter. */
export function optionalTime(value: string | null, name: string): Date | null {
  if (value === null || value === '') {
    return null;
  }
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    throw new HttpError(400, `${name} must be an ISO 8601 time`);
  }
  return time;
}

/**
 * The relayer pays for the metadata it stores, so the server builds it from bounded fields instead of relaying any
 * URI the client sends.
 */
export function profileMetadataURI(body: Record<string, unknown>): string {
  return toDataURI(
    accountMetadata({
      name: optionalText(body.name, 'name', MAX_NAME_CHARACTERS),
      bio: optionalText(body.bio, 'bio', MAX_BIO_CHARACTERS),
      picture: optionalPicture(body.picture),
    })
  );
}
