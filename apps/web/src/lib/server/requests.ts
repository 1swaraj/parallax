import { accountMetadata, toDataURI } from '@lens-monad/protocol';
import { MAX_BIO_CHARACTERS, MAX_NAME_CHARACTERS } from '../config';
import { HttpError } from './guard';

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
