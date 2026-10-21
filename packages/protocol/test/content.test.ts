import { describe, expect, it } from 'vitest';
import {
  contentUrl,
  getMirrorDeployment,
  readPostMetadata,
  readProfileMetadata,
  type Gateways,
} from '../src';

const GROVE_KEY = '0d2f5e8b9c6a4f3e2d1c0b9a8f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c';
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('content URLs', () => {
  it('reads lens://, ipfs:// and ar:// through gateways, and https as it is', () => {
    expect(contentUrl(`lens://${GROVE_KEY}`)).toBe(`https://api.grove.storage/${GROVE_KEY}`);
    expect(contentUrl(`ipfs://${CID}`)).toBe(`https://ipfs.io/ipfs/${CID}`);
    expect(contentUrl(`ipfs://ipfs/${CID}/metadata.json`)).toBe(
      `https://ipfs.io/ipfs/${CID}/metadata.json`
    );
    expect(contentUrl('ar://Vx6Rz0E0YK1pQnOPNi9Ji2Ax6gk8JMaOGdV0Bp8TAk8')).toBe(
      'https://arweave.net/Vx6Rz0E0YK1pQnOPNi9Ji2Ax6gk8JMaOGdV0Bp8TAk8'
    );
    expect(contentUrl(' https://example.com/post.json ')).toBe('https://example.com/post.json');
  });

  it('uses the gateways given', () => {
    const gateways: Gateways = {
      grove: 'https://grove.example/',
      ipfs: 'https://ipfs.example/ipfs/',
      arweave: 'https://ar.example/',
    };
    expect(contentUrl(`lens://${GROVE_KEY}`, gateways)).toBe(`https://grove.example/${GROVE_KEY}`);
    expect(contentUrl(`ipfs://${CID}`, gateways)).toBe(`https://ipfs.example/ipfs/${CID}`);
  });

  it('refuses what a browser or server shouldn’t fetch', () => {
    for (const uri of [
      'data:application/json,{}',
      'http://example.com/post.json',
      'https://user:secret@example.com/post.json',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'lens://',
      'lens://../admin',
      `lens://${GROVE_KEY}/../../admin`,
      'ipfs://%2e%2e/admin',
      'ipfs://a b',
      'ar://./x',
      'not a uri',
    ]) {
      expect(contentUrl(uri), uri).toBeNull();
    }
  });
});

describe('post metadata', () => {
  it('reads Lens v3 text posts', () => {
    expect(
      readPostMetadata({
        $schema: 'https://json-schemas.lens.dev/posts/text-only/3.0.0.json',
        lens: {
          id: '1',
          content: 'gm @lens/stani #lens',
          locale: 'en',
          mainContentFocus: 'TEXT_ONLY',
        },
      })
    ).toEqual({ content: 'gm @lens/stani #lens', image: null, media: null });
  });

  it('reads an image post, with its description and size', () => {
    expect(
      readPostMetadata({
        $schema: 'https://json-schemas.lens.dev/posts/image/3.0.0.json',
        lens: {
          mainContentFocus: 'IMAGE',
          content: 'sunset',
          image: {
            item: `lens://${GROVE_KEY}`,
            type: 'image/jpeg',
            altTag: 'The sea at dusk',
            attributes: [
              { type: 'Number', key: 'width', value: '1200' },
              { type: 'Number', key: 'height', value: '800' },
            ],
          },
        },
      })
    ).toEqual({
      content: 'sunset',
      image: {
        item: `lens://${GROVE_KEY}`,
        type: 'image/jpeg',
        alt: 'The sea at dusk',
        width: 1200,
        height: 800,
        locator: null,
      },
      media: null,
    });
  });

  it('links the media of other types: video, audio, links, embeds, 3D', () => {
    const lens = (fields: Record<string, unknown>) =>
      readPostMetadata({ lens: { content: 'watch this', ...fields } })?.media;
    expect(
      lens({ video: { item: `ipfs://${CID}`, type: 'video/mp4', cover: 'ipfs://cover' } })
    ).toEqual({ kind: 'video', item: `ipfs://${CID}`, type: 'video/mp4' });
    expect(lens({ audio: { item: 'ar://song', type: 'audio/mpeg' } })).toEqual({
      kind: 'audio',
      item: 'ar://song',
      type: 'audio/mpeg',
    });
    expect(lens({ sharingLink: 'https://lens.xyz' })).toEqual({
      kind: 'link',
      item: 'https://lens.xyz',
      type: null,
    });
    expect(lens({ embed: 'https://embed.example/x' })?.kind).toBe('link');
    expect(lens({ playbackUrl: 'https://live.example/stream.m3u8' })?.kind).toBe('link');
    expect(lens({ assets: [{ uri: 'lens://model', format: 'GLTF' }] })).toEqual({
      kind: 'file',
      item: 'lens://model',
      type: null,
    });
    expect(lens({ attachments: [{ item: 'lens://doc', type: 'application/pdf' }] })).toEqual({
      kind: 'file',
      item: 'lens://doc',
      type: 'application/pdf',
    });
  });

  it('puts an article’s title first, and shows its first image attachment', () => {
    const metadata = readPostMetadata({
      $schema: 'https://json-schemas.lens.dev/posts/article/3.0.0.json',
      lens: {
        title: 'Lens on Monad',
        content: '# Why\n\nBecause.',
        attachments: [
          { item: 'lens://doc', type: 'application/pdf' },
          { item: 'lens://cover', type: 'image/png' },
        ],
      },
    });
    expect(metadata?.content).toBe('Lens on Monad\n\n# Why\n\nBecause.');
    expect(metadata?.image?.item).toBe('lens://cover');
    expect(metadata?.media).toEqual({ kind: 'file', item: 'lens://doc', type: 'application/pdf' });
  });

  it('reads a story’s asset as its image or its video', () => {
    expect(
      readPostMetadata({ lens: { asset: { item: 'lens://still', type: 'image/webp' } } })?.image
        ?.item
    ).toBe('lens://still');
    expect(
      readPostMetadata({ lens: { asset: { item: 'lens://clip', type: 'video/mp4' } } })?.media
    ).toEqual({ kind: 'video', item: 'lens://clip', type: 'video/mp4' });
  });

  it('reads Lens v1 and v2 publications: content and typed media', () => {
    expect(
      readPostMetadata({
        version: '2.0.0',
        metadata_id: 'x',
        content: 'old post',
        mainContentFocus: 'VIDEO',
        media: [
          { item: `ipfs://${CID}`, type: 'video/mp4' },
          { item: 'ipfs://still', type: 'image/png', altTag: 'still' },
        ],
      })
    ).toEqual({
      content: 'old post',
      image: {
        item: 'ipfs://still',
        type: 'image/png',
        alt: 'still',
        width: null,
        height: null,
        locator: null,
      },
      media: { kind: 'video', item: `ipfs://${CID}`, type: 'video/mp4' },
    });
    expect(
      readPostMetadata({ version: '1.0.0', description: 'described', image: 'ipfs://img' })
    ).toMatchObject({ content: 'described', image: { item: 'ipfs://img' } });
  });

  it('cuts what is too long, and says nothing for what an app can’t show', () => {
    expect(readPostMetadata({ lens: { content: 'x'.repeat(30_000) } })?.content?.length).toBe(
      25_000
    );
    for (const json of [null, 'text', 42, [], {}, { lens: {} }, { lens: { content: '  ' } }]) {
      expect(readPostMetadata(json)).toBeNull();
    }
  });
});

describe('profile metadata', () => {
  it('reads Lens v3 accounts and v2 profiles', () => {
    expect(
      readProfileMetadata({
        $schema: 'https://json-schemas.lens.dev/account/1.0.0.json',
        lens: { id: '1', name: 'Stani', bio: 'Lens', picture: `lens://${GROVE_KEY}` },
      })
    ).toEqual({ name: 'Stani', bio: 'Lens', picture: `lens://${GROVE_KEY}` });
    expect(
      readProfileMetadata({
        $schema: 'https://json-schemas.lens.dev/profile/2.0.0.json',
        lens: { name: 'Old', picture: `ipfs://${CID}` },
      })
    ).toEqual({ name: 'Old', bio: null, picture: `ipfs://${CID}` });
  });

  it('reads Lens v1 profiles, which keep the picture onchain', () => {
    expect(readProfileMetadata({ version: '1.0.0', name: 'V1', bio: 'bio' })).toEqual({
      name: 'V1',
      bio: 'bio',
      picture: null,
    });
    expect(readProfileMetadata('nope')).toBeNull();
  });
});

describe('mirror deployments', () => {
  it('says when a chain’s mirror is still a placeholder, or unknown', () => {
    expect(() => getMirrorDeployment(10143)).toThrow(/isn't deployed on Monad testnet yet/);
    expect(() => getMirrorDeployment(1)).toThrow(/No mirror of Lens Chain is known on chain 1/);
  });
});
