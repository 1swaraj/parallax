import { EMPTY_SOURCE_STAMP, sponsorRouterAbi } from '@lens-monad/protocol';
import { decodeFunctionData, encodeFunctionData, zeroAddress, zeroHash } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/profile/route';
import { sendAsRelayer } from '../src/lib/server/chain';

vi.mock('../src/lib/server/chain', () => ({ sendAsRelayer: vi.fn() }));
vi.mock('../src/lib/server/session', () => ({ getSession: vi.fn(async () => ({})) }));
vi.mock('../src/lib/server/sponsor', () => ({
  sponsoredAccount: vi.fn(async () => '0x0000000000000000000000000000000000001234'),
}));

afterEach(() => vi.unstubAllEnvs());

it('encodes the profile route with the deployed three-argument SponsorRouter ABI', async () => {
  vi.stubEnv('RELAY_PAUSED', 'false');
  vi.mocked(sendAsRelayer).mockImplementation(async (call) => {
    // Encode the actual route arguments: the old two-argument call fails here before broadcast.
    const data = encodeFunctionData(call as never);
    const decoded = decodeFunctionData({ abi: sponsorRouterAbi, data });
    expect(decoded.functionName).toBe('setMetadataURI');
    expect(decoded.args).toEqual([
      '0x0000000000000000000000000000000000001234',
      expect.stringContaining('data:application/json'),
      { ...EMPTY_SOURCE_STAMP, source: zeroAddress },
    ]);
    return { hash: zeroHash, blockNumber: 1n, logs: [] };
  });

  const response = await POST(
    new Request('http://localhost:3000/api/profile', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Testnet profile', bio: 'building on Monad' }),
    })
  );
  expect(response.status).toBe(200);
  expect(sendAsRelayer).toHaveBeenCalledOnce();
});
