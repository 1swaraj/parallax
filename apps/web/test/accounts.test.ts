// Signing in looks up the signer's Accounts in the indexer: when it can't be reached or isn't serving yet (a new one
// still syncing), the user gets a 503 to retry, not an internal error.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountsOwnedBy } from '../src/lib/server/accounts';
import { HttpError } from '../src/lib/server/guard';
import { randomAddress } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('accountsOwnedBy', () => {
  it('answers 503 when the indexer is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const error = await accountsOwnedBy(randomAddress()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503 });
  });

  it("answers 503 when the indexer isn't serving, e.g. Railway's 404 before its first deployment is up", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const error = await accountsOwnedBy(randomAddress()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, message: expect.stringMatching(/try again/i) });
  });

  it('finds none without asking the chain when the indexer has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ items: [], next: null }, { status: 200 }))
    );
    expect(await accountsOwnedBy(randomAddress())).toEqual([]);
  });
});
