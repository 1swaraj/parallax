// End-to-end test of post images against the local stack (see api.e2e.test.ts): chunks relayed to MediaStore, read
// back from the indexer through the app's /media, an image post, and the caps on what the relayer pays for.

import {
  createPost,
  getMediaStore,
  imagePost,
  MAX_IMAGE_BYTES,
  MEDIA_CHUNK_BYTES,
  mediaId,
  mediaPath,
  mediaStoreAbi,
  putMedia,
  toDataURI,
  type ThreadView,
} from '@lens-monad/protocol';
import { bytesToHex, encodeFunctionData, type Hex } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { maxGasPerImagePost, maxGasPerMediaChunk } from '../src/lib/server/env';
import { APP, CHAIN_ID, chainClient, contracts, indexed, user } from './e2e';

const store = getMediaStore(CHAIN_ID);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes that sniff as a PNG: its signature, then random bytes (incompressible, like a real image's). */
function fakePng(size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65_536) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65_536)));
  }
  bytes.set(PNG_SIGNATURE);
  return bytes;
}

async function media(author: string, id: Hex) {
  return fetch(`${APP}${mediaPath(author as Hex, id)}`);
}

describe.skipIf(!store)('post images', () => {
  const alice = user();
  let account: Hex;

  beforeAll(async () => {
    expect((await alice.signIn()).status).toBe(200);
    const signUp = await alice.call<{ account: Hex }>('/api/signup', {
      method: 'POST',
      body: { username: `img${Date.now().toString(36)}` },
    });
    expect(signUp.status, signUp.body.error).toBe(200);
    account = signUp.body.account;
  });

  it('stores an image in chunks, and serves it once they are all in', async () => {
    const bytes = fakePng(100 * 1024);
    const id = await mediaId(bytes);
    const [first, second] = putMedia(store!.address, id, bytes);
    expect(second).toBeDefined();

    const sent = await alice.call<{ hash: Hex; blockNumber: string }>('/api/relay', {
      method: 'POST',
      body: first,
    });
    expect(sent.status, sent.body.error).toBe(200);
    // A full chunk is mostly calldata: its gas limit is under the cap the relayer sends it with.
    const { gas } = await chainClient.getTransaction({ hash: sent.body.hash });
    expect(gas).toBeLessThan(maxGasPerMediaChunk());

    // Half an image isn't served.
    await indexed('/status', () => true);
    expect((await media(account, id)).status).toBe(404);

    const rest = await alice.call<{ blockNumber: string }>('/api/relay', {
      method: 'POST',
      body: second,
    });
    expect(rest.status, rest.body.error).toBe(200);
    let response = await media(account, id);
    for (let i = 0; i < 50 && response.status === 404; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      response = await media(account, id);
    }
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    // Someone else's media path with the same id has nothing.
    expect((await media(contracts.LensGlobalFeed, id)).status).toBe(404);
  });

  it('posts an image, which the post shows from /media', async () => {
    const bytes = fakePng(2048);
    const id = await mediaId(bytes);
    for (const call of putMedia(store!.address, id, bytes)) {
      const sent = await alice.call('/api/relay', { method: 'POST', body: call });
      expect(sent.status, sent.body.error).toBe(200);
    }
    const metadata = imagePost('look', {
      item: `${APP}${mediaPath(account, id)}`,
      type: 'image/png',
      width: 640,
      height: 480,
      alt: 'A test pattern',
      locator: { chainId: CHAIN_ID, store: store!.address, author: account, id },
    });
    const posted = await alice.call<{ postId: string }>('/api/relay', {
      method: 'POST',
      body: createPost(contracts.LensGlobalFeed, account, toDataURI(metadata)),
    });
    expect(posted.status, posted.body.error).toBe(200);
    const thread = await indexed<ThreadView>(`/posts/${posted.body.postId}`, () => true);
    expect(thread.post.content).toBe('look');
    expect(thread.post.image).toEqual({
      url: mediaPath(account, id),
      type: 'image/png',
      alt: 'A test pattern',
      width: 640,
      height: 480,
    });
    expect((await fetch(`${APP}${thread.post.image!.url}`)).status).toBe(200);
  });

  it('pays for an image post with a full text and description', async () => {
    const id = `0x${'cd'.repeat(32)}` as Hex;
    const metadata = imagePost('x'.repeat(280), {
      item: `${APP}${mediaPath(account, id)}`,
      type: 'image/webp',
      width: 1280,
      height: 1280,
      alt: 'y'.repeat(420),
      locator: { chainId: CHAIN_ID, store: store!.address, author: account, id },
    });
    const posted = await alice.call<{ hash: Hex }>('/api/relay', {
      method: 'POST',
      body: createPost(contracts.LensGlobalFeed, account, toDataURI(metadata)),
    });
    expect(posted.status, posted.body.error).toBe(200);
    const { gas } = await chainClient.getTransaction({ hash: posted.body.hash });
    expect(gas).toBeLessThan(maxGasPerImagePost());
  });

  it("doesn't serve what isn't an image", async () => {
    const bytes = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const id = await mediaId(bytes);
    const [call] = putMedia(store!.address, id, bytes);
    expect((await alice.call('/api/relay', { method: 'POST', body: call })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await media(account, id)).status).toBe(404);
  });

  it('refuses to pay for chunks over the chunk size, or past the image size', async () => {
    const put = (offset: number, size: number) => ({
      target: store!.address,
      data: encodeFunctionData({
        abi: mediaStoreAbi,
        functionName: 'put',
        args: [`0x${'11'.repeat(32)}`, BigInt(offset), bytesToHex(fakePng(size))],
      }),
    });
    const tooBig = await alice.call('/api/relay', {
      method: 'POST',
      body: put(0, MEDIA_CHUNK_BYTES + 1),
    });
    expect(tooBig.status).toBe(400);
    const pastTheEnd = await alice.call('/api/relay', {
      method: 'POST',
      body: put(MAX_IMAGE_BYTES - 10, 11),
    });
    expect(pastTheEnd.status).toBe(400);
    expect(pastTheEnd.body.error).toMatch(/image that big/);
  });
});
