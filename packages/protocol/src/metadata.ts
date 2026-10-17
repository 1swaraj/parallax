/**
 * Lens metadata (https://github.com/lens-protocol/metadata), stored inline in the contentURI / metadataURI as a base64
 * `data:` URI: there is no storage service on Monad yet, and the contracts' own token URIs use the same encoding.
 * Inline content costs gas per byte (Monad charges cold storage writes ~1.75x Ethereum), so posts stay short.
 */

export const TEXT_ONLY_POST_SCHEMA = 'https://json-schemas.lens.dev/posts/text-only/3.0.0.json';
export const ACCOUNT_SCHEMA = 'https://json-schemas.lens.dev/account/1.0.0.json';

/** Matches Lens' text-only limit, and keeps a post's inline storage bounded. */
export const MAX_POST_LENGTH = 25_000;

export type TextOnlyPostMetadata = {
  $schema: typeof TEXT_ONLY_POST_SCHEMA;
  lens: { id: string; content: string; locale: string; mainContentFocus: 'TEXT_ONLY' };
};

export type AccountMetadata = {
  $schema: typeof ACCOUNT_SCHEMA;
  lens: { id: string; name?: string; bio?: string; picture?: string };
};

export type Profile = { name: string | null; bio: string | null; picture: string | null };

export function textOnlyPost(content: string, locale = 'en'): TextOnlyPostMetadata {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error('A post needs some content');
  }
  if (trimmed.length > MAX_POST_LENGTH) {
    throw new Error(`A post can't be longer than ${MAX_POST_LENGTH} characters`);
  }
  return {
    $schema: TEXT_ONLY_POST_SCHEMA,
    lens: { id: crypto.randomUUID(), content: trimmed, locale, mainContentFocus: 'TEXT_ONLY' },
  };
}

export function accountMetadata(profile: {
  name?: string;
  bio?: string;
  picture?: string;
}): AccountMetadata {
  const lens: AccountMetadata['lens'] = { id: crypto.randomUUID() };
  for (const key of ['name', 'bio', 'picture'] as const) {
    const value = profile[key]?.trim();
    if (value) {
      lens[key] = value;
    }
  }
  return { $schema: ACCOUNT_SCHEMA, lens };
}

export function toDataURI(json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

/** Decodes a JSON `data:` URI, base64 or percent-encoded (RFC 2397). Anything else, or invalid JSON, gives null. */
export function parseDataURI(uri: string): unknown {
  const match = /^data:application\/json(;[^,]*)?,(.*)$/s.exec(uri);
  if (!match) {
    return null;
  }
  const [, params = '', payload = ''] = match;
  try {
    if (params.split(';').includes('base64')) {
      const binary = atob(payload);
      return JSON.parse(
        new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
      );
    }
    return JSON.parse(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

function lensField(json: unknown, field: string): string | null {
  if (typeof json !== 'object' || json === null || !('lens' in json)) {
    return null;
  }
  const lens = (json as { lens: unknown }).lens;
  if (typeof lens !== 'object' || lens === null) {
    return null;
  }
  const value = (lens as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/** The text of a post's metadata, whatever its main content focus, or null when it isn't Lens metadata. */
export function readPostContent(contentURI: string): string | null {
  return lensField(parseDataURI(contentURI), 'content');
}

export function readProfile(metadataURI: string): Profile {
  const json = parseDataURI(metadataURI);
  return {
    name: lensField(json, 'name'),
    bio: lensField(json, 'bio'),
    picture: lensField(json, 'picture'),
  };
}
