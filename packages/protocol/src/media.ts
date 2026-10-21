import {
  bytesToHex,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import type { AccountCall } from './calls';
import { MEDIA_STORE_INIT_CODE, mediaStoreAbi } from './media-store-artifact';
import { MAX_POST_LENGTH, parseDataURI } from './metadata';

export { mediaStoreAbi };

/**
 * Images are stored on-chain, in the history rather than the state: MediaStore.put emits the bytes as a log, so a byte
 * costs ~40 gas of calldata instead of a ~870-gas storage write (27,900 gas per fresh 32-byte slot,
 * https://docs.monad.xyz/developer-essentials/opcode-pricing), and an image fits in a few transactions. The post's
 * metadata is Lens image metadata, whose `item` is an https URL of the app serving the bytes the indexer read back,
 * so other Lens apps can show it, and whose `onchain` attribute says where the bytes are, so anyone can rebuild it.
 */

/**
 * The deterministic deployment proxy (Arachnid's, standardised as EIP-7997's factory), at this address on Monad
 * (https://docs.monad.xyz/developer-essentials/network-information) and on anvil. Deployed through it with a fixed
 * salt, MediaStore has the same address on every chain.
 */
export const CREATE2_FACTORY: Address = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const MEDIA_STORE_SALT: Hex = zeroHash;
export const MEDIA_STORE_ADDRESS: Address = getContractAddress({
  opcode: 'CREATE2',
  from: CREATE2_FACTORY,
  salt: MEDIA_STORE_SALT,
  bytecode: MEDIA_STORE_INIT_CODE,
});

/**
 * The chains MediaStore is deployed on (scripts/deploy-media-store.ts), and the block indexers read it from. Images
 * are off on the others.
 */
const MEDIA_STORE_DEPLOYMENTS: Partial<Record<number, { deploymentBlock: number }>> = {
  31337: { deploymentBlock: 0 },
  10143: { deploymentBlock: 72_375_566 },
};

export type MediaStoreDeployment = { address: Address; deploymentBlock: number };

export function getMediaStore(chainId: number): MediaStoreDeployment | null {
  const deployment = MEDIA_STORE_DEPLOYMENTS[chainId];
  return deployment ? { address: MEDIA_STORE_ADDRESS, ...deployment } : null;
}

/**
 * Bytes of media per transaction. 64 KiB transactions are known to go through on Monad mainnet (streaming-pod sends
 * video in them); the docs give no size limit for a transaction, only its 30M gas limit
 * (https://docs.monad.xyz/developer-essentials/gas-pricing).
 */
export const MEDIA_CHUNK_BYTES = 64 * 1024;

/** The app's images: at most this many pixels on the longest side, re-encoded to fit in MAX_IMAGE_BYTES. */
export const MAX_IMAGE_DIMENSION = 1280;
/** Two chunks: ~5.4M gas, about 7 times a text post. */
export const MAX_IMAGE_BYTES = 120 * 1024;

/** What indexers keep of a media: chunks past it are ignored, so an author can't fill the indexer's database. */
export const MAX_MEDIA_BYTES = 1024 * 1024;

/** A media's id: the SHA-256 of its bytes. */
export async function mediaId(bytes: Uint8Array): Promise<Hex> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

/** The calls that store `bytes` as the Account's media `id`, MEDIA_CHUNK_BYTES each. */
export function putMedia(store: Address, id: Hex, bytes: Uint8Array): AccountCall[] {
  const calls: AccountCall[] = [];
  for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES) {
    calls.push({
      target: store,
      data: encodeFunctionData({
        abi: mediaStoreAbi,
        functionName: 'put',
        args: [id, BigInt(offset), bytesToHex(bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES))],
      }),
    });
  }
  return calls;
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

function startsWith(bytes: Uint8Array, prefix: number[], at = 0) {
  return prefix.every((byte, i) => bytes[at + i] === byte);
}

/**
 * The image type of these bytes, from their magic number, or null for anything else. The app only serves what this
 * recognises, with this type: never HTML, SVG or whatever an author claims the bytes are.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  // GIF87a, GIF89a
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    [0x37, 0x39].includes(bytes[4]!) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  return null;
}

/** Where a media's bytes are: MediaStore's logs on a chain, by author and id. */
export type MediaLocator = { chainId: number; store: Address; author: Address; id: Hex };

const LOCATOR = /^eip155:(\d{1,12}):(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-f]{64})$/;

/** `eip155:<chainId>:<MediaStore>/<author>/<id>`, a CAIP-10 address followed by the media. */
export function formatMediaLocator(locator: MediaLocator): string {
  return `eip155:${locator.chainId}:${getAddress(locator.store)}/${getAddress(locator.author)}/${locator.id}`;
}

export function parseMediaLocator(value: string): MediaLocator | null {
  const match = LOCATOR.exec(value);
  if (!match) {
    return null;
  }
  const [, chainId, store, author, id] = match;
  return {
    chainId: Number(chainId),
    store: getAddress(store!),
    author: getAddress(author!),
    id: id as Hex,
  };
}

/** The path the app serves a media at (proxied to the indexer's /media). */
export function mediaPath(author: Address, id: Hex): string {
  return `/media/${getAddress(author)}/${id}`;
}

export const IMAGE_POST_SCHEMA = 'https://json-schemas.lens.dev/posts/image/3.0.0.json';

type Attribute = { type: 'String' | 'Number'; key: string; value: string };

export type ImagePostMetadata = {
  $schema: typeof IMAGE_POST_SCHEMA;
  lens: {
    id: string;
    locale: string;
    mainContentFocus: 'IMAGE';
    content?: string;
    image: { item: string; type: ImageType; altTag?: string; attributes: Attribute[] };
  };
};

export type ImageInput = {
  /** An absolute URL the image is served at, for other Lens apps: the app's origin and mediaPath. */
  item: string;
  type: ImageType;
  width: number;
  height: number;
  locator: MediaLocator;
  alt?: string;
};

/** Lens image metadata (https://github.com/lens-protocol/metadata, ImageSchema), with optional text. */
export function imagePost(content: string, image: ImageInput, locale = 'en'): ImagePostMetadata {
  const trimmed = content.trim();
  if (trimmed.length > MAX_POST_LENGTH) {
    throw new Error(`A post can't be longer than ${MAX_POST_LENGTH} characters`);
  }
  const alt = image.alt?.trim();
  return {
    $schema: IMAGE_POST_SCHEMA,
    lens: {
      id: crypto.randomUUID(),
      locale,
      mainContentFocus: 'IMAGE',
      ...(trimmed ? { content: trimmed } : {}),
      image: {
        item: image.item,
        type: image.type,
        ...(alt ? { altTag: alt } : {}),
        attributes: [
          { type: 'Number', key: 'width', value: String(image.width) },
          { type: 'Number', key: 'height', value: String(image.height) },
          { type: 'String', key: 'onchain', value: formatMediaLocator(image.locator) },
        ],
      },
    },
  };
}

/** A post's image, as its metadata describes it. */
export type PostImage = {
  item: string;
  type: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  locator: MediaLocator | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function dimension(value: string | undefined) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 100_000 ? number : null;
}

/** The image of a post's inline Lens metadata (image posts' `image`), or null when it has none. */
export function readPostImage(contentURI: string): PostImage | null {
  return readImage(record(record(parseDataURI(contentURI))?.lens)?.image);
}

/** A Lens metadata image (`{ item, type, altTag, attributes }`), or null without an item and a type. */
export function readImage(value: unknown): PostImage | null {
  const image = record(value);
  if (!image || typeof image.item !== 'string' || typeof image.type !== 'string') {
    return null;
  }
  const attributes = new Map<string, string>();
  if (Array.isArray(image.attributes)) {
    for (const attribute of image.attributes.map(record)) {
      if (typeof attribute?.key === 'string' && typeof attribute.value === 'string') {
        attributes.set(attribute.key, attribute.value);
      }
    }
  }
  const locator = attributes.get('onchain');
  return {
    item: image.item,
    type: image.type,
    alt: typeof image.altTag === 'string' && image.altTag.trim() ? image.altTag : null,
    width: dimension(attributes.get('width')),
    height: dimension(attributes.get('height')),
    locator: locator ? parseMediaLocator(locator) : null,
  };
}
