import {
  decodeFunctionData,
  encodeErrorResult,
  getAddress,
  ContractFunctionRevertedError,
  ContractFunctionExecutionError,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  accountAbi,
  createPost,
  describeLensError,
  directExecution,
  feedAbi,
  graphAbi,
  follow,
  lensErrorName,
  lensErrorsAbi,
  parseDataURI,
  readPostContent,
  readProfile,
  repost,
  textOnlyPost,
  toDataURI,
  accountMetadata,
  usernameError,
} from '../src';

const feed = getAddress('0x7bc9a7e2bdf4c4f6b1ff8cff272310a4b17f783d');
const graph = getAddress('0x6ddff2df38d87dc8ccdfcfcdfdb3608bc296ed60');
const alice = getAddress('0x00000000000000000000000000000000000a11ce');
const bob = getAddress('0x0000000000000000000000000000000000000b0b');

describe('metadata', () => {
  it('round-trips unicode posts through base64 data URIs', () => {
    const uri = toDataURI(textOnlyPost('  gm 🌞 — ünïcödé  '));
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    expect(readPostContent(uri)).toBe('gm 🌞 — ünïcödé');
  });

  it('reads percent-encoded data URIs, and ignores everything else', () => {
    const json = { lens: { content: '100% & more' } };
    expect(
      parseDataURI(`data:application/json,${encodeURIComponent(JSON.stringify(json))}`)
    ).toEqual(json);
    expect(readPostContent('ipfs://bafy')).toBeNull();
    expect(readPostContent('data:application/json;base64,not-base64!')).toBeNull();
    expect(readPostContent(toDataURI({ lens: { content: 42 } }))).toBeNull();
  });

  it('rejects empty posts', () => {
    expect(() => textOnlyPost('   ')).toThrow();
  });

  it('keeps only non-empty profile fields', () => {
    const metadata = accountMetadata({ name: ' Alice ', bio: '' });
    expect(metadata.lens).toEqual({ id: metadata.lens.id, name: 'Alice' });
    expect(readProfile(toDataURI(metadata))).toEqual({ name: 'Alice', bio: null, picture: null });
  });
});

describe('calls', () => {
  it('encodes replies and quotes in the right fields', () => {
    const call = createPost(feed, alice, 'uri', { kind: 'reply-quote', replyTo: 1n, quoteOf: 2n });
    expect(call.target).toBe(feed);
    const { functionName, args } = decodeFunctionData({ abi: feedAbi, data: call.data });
    expect(functionName).toBe('createPost');
    expect(args[0]).toMatchObject({
      author: alice,
      contentURI: 'uri',
      repliedPostId: 1n,
      quotedPostId: 2n,
      repostedPostId: 0n,
    });
  });

  it('encodes reposts without content', () => {
    const { args } = decodeFunctionData({ abi: feedAbi, data: repost(feed, alice, 7n).data });
    expect(args[0]).toMatchObject({
      contentURI: '',
      repostedPostId: 7n,
      repliedPostId: 0n,
      quotedPostId: 0n,
    });
  });

  it('wraps calls for direct execution by the owner', () => {
    const call = follow(graph, alice, bob);
    const { functionName, args } = decodeFunctionData({
      abi: accountAbi,
      data: directExecution(call),
    });
    expect(functionName).toBe('executeTransaction');
    expect(args).toEqual([graph, 0n, call.data]);
    expect(decodeFunctionData({ abi: graphAbi, data: call.data }).args.slice(0, 2)).toEqual([
      alice,
      bob,
    ]);
  });
});

describe('usernames', () => {
  it('mirrors the launch Namespace rules', () => {
    expect(usernameError('alice')).toBeNull();
    expect(usernameError('a_b-1')).toBeNull();
    expect(usernameError('abc')).toMatch(/4/);
    expect(usernameError('_alice')).toMatch(/Starts/);
    expect(usernameError('Alice')).toMatch(/Starts/);
    expect(usernameError('ali.ce')).toMatch(/Only/);
  });
});

describe('errors', () => {
  it('decodes Lens errors bubbled through other contracts', () => {
    const data = encodeErrorResult({ abi: lensErrorsAbi, errorName: 'CannotFollowAgain' });
    const error = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: [], data, functionName: 'execute' }),
      { abi: [], functionName: 'execute' }
    );
    expect(lensErrorName(error)).toBe('CannotFollowAgain');
    expect(describeLensError(error)).toBe('You already follow this account.');
  });
});
