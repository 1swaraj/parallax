import {
  concat,
  decodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CREATE2_FACTORY,
  formatMediaLocator,
  imagePost,
  MEDIA_CHUNK_BYTES,
  MEDIA_STORE_ADDRESS,
  MEDIA_STORE_SALT,
  mediaId,
  mediaStoreAbi,
  parseMediaLocator,
  putMedia,
  readPostContent,
  readPostImage,
  sniffImageType,
  textOnlyPost,
  toDataURI,
} from '../src';
import { MEDIA_STORE_INIT_CODE } from '../src/media-store-artifact';

const store = MEDIA_STORE_ADDRESS;
const author = getAddress('0x7bc9a7e2bdf4c4f6b1ff8cff272310a4b17f783d');
const id = `0x${'ab'.repeat(32)}` as Hex;

describe('MediaStore', () => {
  it("is at its init code's CREATE2 address from the deterministic factory", () => {
    const hash = keccak256(
      concat(['0xff', CREATE2_FACTORY, MEDIA_STORE_SALT, keccak256(MEDIA_STORE_INIT_CODE)])
    );
    expect(MEDIA_STORE_ADDRESS).toBe(getAddress(`0x${hash.slice(-40)}`));
    expect(MEDIA_STORE_ADDRESS).toBe(
      getContractAddress({
        opcode: 'CREATE2',
        from: CREATE2_FACTORY,
        salt: MEDIA_STORE_SALT,
        bytecode: MEDIA_STORE_INIT_CODE,
      })
    );
  });
});

describe('media', () => {
  it('ids media by their SHA-256', async () => {
    expect(await mediaId(new TextEncoder().encode('abc'))).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('splits media into chunks at their offsets', () => {
    const bytes = new Uint8Array(MEDIA_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    const calls = putMedia(store, id, bytes);
    expect(calls).toHaveLength(3);
    const decoded = calls.map((call) =>
      decodeFunctionData({ abi: mediaStoreAbi, data: call.data })
    );
    expect(decoded.map(({ args }) => args[1])).toEqual([
      0n,
      BigInt(MEDIA_CHUNK_BYTES),
      BigInt(MEDIA_CHUNK_BYTES * 2),
    ]);
    expect(decoded.map(({ args }) => (args[2].length - 2) / 2)).toEqual([
      MEDIA_CHUNK_BYTES,
      MEDIA_CHUNK_BYTES,
      10,
    ]);
    expect(calls.every((call) => call.target === store)).toBe(true);
  });

  it('recognises images by their magic number, and nothing else', () => {
    const of = (...bytes: number[]) => new Uint8Array([...bytes, 0, 0, 0, 0]);
    expect(sniffImageType(of(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImageType(of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffImageType(of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(
      'image/webp'
    );
    expect(sniffImageType(of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    // A WAV is RIFF too.
    expect(
      sniffImageType(of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))
    ).toBeNull();
    expect(
      sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it('round-trips locators, and refuses malformed ones', () => {
    const locator = { chainId: 143, store, author, id };
    expect(formatMediaLocator(locator)).toBe(`eip155:143:${store}/${author}/${id}`);
    expect(parseMediaLocator(formatMediaLocator(locator))).toEqual(locator);
    expect(parseMediaLocator(`eip155:143:${store}/${author}`)).toBeNull();
    expect(parseMediaLocator(`eip155:143:${store}/${author}/${id.toUpperCase()}`)).toBeNull();
  });
});

describe('image posts', () => {
  const image = {
    item: `https://parallax.example/media/${author}/${id}`,
    type: 'image/webp' as const,
    width: 1280,
    height: 960,
    alt: '  A cat  ',
    locator: { chainId: 143, store, author, id },
  };

  it('are Lens image metadata, whose image the reader finds', () => {
    const metadata = imagePost(' hello ', image);
    expect(metadata.$schema).toBe('https://json-schemas.lens.dev/posts/image/3.0.0.json');
    expect(metadata.lens).toMatchObject({ mainContentFocus: 'IMAGE', content: 'hello' });
    const uri = toDataURI(metadata);
    expect(readPostContent(uri)).toBe('hello');
    expect(readPostImage(uri)).toEqual({
      item: image.item,
      type: 'image/webp',
      alt: 'A cat',
      width: 1280,
      height: 960,
      locator: image.locator,
    });
  });

  it('may have no text', () => {
    const uri = toDataURI(imagePost('  ', { ...image, alt: undefined }));
    expect(readPostContent(uri)).toBeNull();
    expect(readPostImage(uri)).toMatchObject({ alt: null, width: 1280 });
  });

  it("aren't found in text posts or malformed metadata", () => {
    expect(readPostImage(toDataURI(textOnlyPost('hi')))).toBeNull();
    expect(readPostImage(toDataURI({ lens: { image: { item: 42 } } }))).toBeNull();
    expect(readPostImage('https://example.com/post.json')).toBeNull();
  });
});
