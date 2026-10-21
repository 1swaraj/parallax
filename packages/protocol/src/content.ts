import { readImage, type PostImage } from './media';
import { MAX_POST_LENGTH, type Profile } from './metadata';

/**
 * Lens content wherever it lives. Posts and accounts point at their Lens metadata with a URI: inline `data:`, like
 * Parallax's own, or, from Lens Chain, `lens://` (Grove), `ipfs://`, `ar://` or `https://`, which readers fetch
 * through a gateway. The metadata comes in many types (text, image, video, article, link…) and versions: Lens v1's and
 * v2's flat `content` and `media` (1.0.0, 2.0.0), and the `lens` object of the 3.0.0 schemas (Lens v2 publications, v3
 * posts). readPostMetadata takes the text and the image of any of them, and a link to their other media, so every post
 * shows one way or another.
 */

/** Where each kind of URI is read: base URLs, ending with `/`, that the URI's path is appended to. */
export type Gateways = { grove: string; ipfs: string; arweave: string };

export const DEFAULT_GATEWAYS: Gateways = {
  // Grove, Lens' storage, serves lens://<key> at https://api.grove.storage/<key>.
  grove: 'https://api.grove.storage/',
  ipfs: 'https://ipfs.io/ipfs/',
  arweave: 'https://arweave.net/',
};

/** Longer names are cut: a profile's name shows on one line. */
const MAX_NAME_LENGTH = 200;

// A path segment after lens://, ipfs:// or ar://: no `%`, which URL parsers decode, so `.` and `..` are the only
// segments that could leave the gateway's path, and they're refused.
const GATEWAY_SEGMENT = /^[A-Za-z0-9._~-]+$/;

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function underGateway(gateway: string, path: string): string | null {
  const segments = path.split('/');
  if (!segments.every((s) => GATEWAY_SEGMENT.test(s) && s !== '.' && s !== '..')) {
    return null;
  }
  const url = httpsUrl(`${gateway}${path}`);
  return url?.startsWith(gateway) ? url : null;
}

/**
 * The https URL `uri` is read at: Grove for `lens://`, the gateways for `ipfs://` and `ar://`, `https://` URLs as they
 * are. Null for anything else: inline `data:` URIs, plain `http://`, URLs with credentials, unknown schemes.
 */
export function contentUrl(uri: string, gateways: Gateways = DEFAULT_GATEWAYS): string | null {
  const value = uri.trim();
  const [, scheme, rest] = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(value) ?? [];
  switch (scheme?.toLowerCase()) {
    case 'https':
      return httpsUrl(value);
    case 'lens':
      return underGateway(gateways.grove, rest!);
    case 'ipfs':
      return underGateway(gateways.ipfs, rest!.replace(/^ipfs\//, ''));
    case 'ar':
      return underGateway(gateways.arweave, rest!);
    default:
      return null;
  }
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file' | 'link';

/** Media a post links to rather than shows (video, audio, a file, a link), with the URI its metadata gives. */
export type MediaItem = { kind: MediaKind; item: string; type: string | null };

/** What a post's metadata says: its text (an article's title first), its image, and its other media. */
export type PostMetadata = {
  content: string | null;
  image: PostImage | null;
  media: MediaItem | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== null) : [];
}

function text(value: unknown, max = MAX_POST_LENGTH): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, max) : null;
}

function kindOf(type: unknown): MediaKind {
  const family = typeof type === 'string' ? type.split('/')[0] : '';
  return family === 'image' || family === 'video' || family === 'audio' ? family : 'file';
}

function mediaItem(value: unknown, kind?: MediaKind): MediaItem | null {
  const media = record(value);
  if (typeof media?.item !== 'string' || !media.item.trim()) {
    return null;
  }
  const type = typeof media.type === 'string' ? media.type : null;
  return { kind: kind ?? kindOf(type), item: media.item.trim(), type };
}

function link(value: unknown): MediaItem | null {
  const item = text(value, 2048);
  return item ? { kind: 'link', item, type: null } : null;
}

/** The 3.0.0 schemas' `lens` object, whatever the main content focus. */
function fromLens(lens: Record<string, unknown>): PostMetadata {
  const title = text(lens.title, 300);
  const body = text(lens.content);
  const attachments = records(lens.attachments);
  // A story's one asset, an image or a video.
  const asset = record(lens.asset);
  const images = [lens.image, ...attachments, asset].filter(
    (item) => kindOf(record(item)?.type) === 'image'
  );
  return {
    content: title && body && !body.startsWith(title) ? `${title}\n\n${body}` : (body ?? title),
    image: images.map((item) => readImage(item)).find((image) => image !== null) ?? null,
    media:
      mediaItem(lens.video, 'video') ??
      mediaItem(lens.audio, 'audio') ??
      [asset, ...attachments]
        .filter((item) => kindOf(item?.type) !== 'image')
        .map((item) => mediaItem(item))
        .find((item) => item !== null) ??
      // Links, livestreams, embeds, mints and spaces.
      link(lens.sharingLink) ??
      link(lens.playbackUrl) ??
      link(lens.liveUrl) ??
      link(lens.embed) ??
      link(lens.mintLink) ??
      link(lens.link) ??
      // 3D models.
      records(lens.assets)
        .map((model) => (typeof model.uri === 'string' ? mediaItem({ item: model.uri }) : null))
        .find((item) => item !== null) ??
      null,
  };
}

/** Lens v1 and v2 publications (1.0.0, 2.0.0): `content`, and `media` items with their MIME type. */
function fromLegacy(root: Record<string, unknown>): PostMetadata {
  const media = records(root.media);
  const image =
    media
      .filter((item) => kindOf(item.type) === 'image')
      .map((item) => readImage(item))
      .find((item) => item !== null) ??
    (typeof root.image === 'string'
      ? readImage({
          item: root.image,
          type: typeof root.imageMimeType === 'string' ? root.imageMimeType : 'image',
        })
      : null);
  return {
    content: text(root.content) ?? text(root.description),
    image,
    media:
      media
        .filter((item) => kindOf(item.type) !== 'image')
        .map((item) => mediaItem(item))
        .find((item) => item !== null) ?? null,
  };
}

/** What a post's Lens metadata says, whatever its type and version, or null when it says nothing an app can show. */
export function readPostMetadata(json: unknown): PostMetadata | null {
  const root = record(json);
  if (!root) {
    return null;
  }
  const lens = record(root.lens);
  const metadata = lens ? fromLens(lens) : fromLegacy(root);
  return metadata.content !== null || metadata.image || metadata.media ? metadata : null;
}

/**
 * A profile from an account's metadata: account 1.0.0 and Lens v2's profile 2.0.0 (the `lens` object), or v1's flat
 * 1.0.0. The picture is the URI as given (contentUrl reads it). Null for anything that isn't an object.
 */
export function readProfileMetadata(json: unknown): Profile | null {
  const root = record(json);
  if (!root) {
    return null;
  }
  const profile = record(root.lens) ?? root;
  return {
    name: text(profile.name, MAX_NAME_LENGTH),
    bio: text(profile.bio),
    picture: text(profile.picture, 2048),
  };
}
