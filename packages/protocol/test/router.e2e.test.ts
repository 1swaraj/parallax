import { createPublicClient, createWalletClient, http, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it } from 'vitest';
import { deployInstanceRouter, getDeployment, sponsorRouterAbi } from '../src';
import { localTestChain as chain } from './local-chain';

it('atomically initializes an independent router, copies functions, and isolates owner and relayers', async () => {
  const transport = http(chain.rpcUrls.default.http[0]);
  const client = createPublicClient({ chain, transport, pollingInterval: 50 });
  const wallet = createWalletClient({
    chain,
    transport,
    account: privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    ),
  });
  const stranger = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  );
  const referenceRouter = getDeployment(chain.id).contracts.SponsorRouter;
  const result = await deployInstanceRouter({
    client,
    wallet,
    referenceRouter,
    relayers: [stranger.address],
  });
  expect(result.owner).toBe(wallet.account.address);
  expect(result.router.toLowerCase()).not.toBe(referenceRouter.toLowerCase());
  expect(
    await client.readContract({
      address: result.router,
      abi: sponsorRouterAbi,
      functionName: 'isRelayer',
      args: [stranger.address],
    })
  ).toBe(true);
  expect(
    await client.readContract({
      address: result.router,
      abi: sponsorRouterAbi,
      functionName: 'isRelayer',
      args: [wallet.account.address],
    })
  ).toBe(false);
  await expect(
    client.simulateContract({
      account: stranger,
      address: result.router,
      abi: sponsorRouterAbi,
      functionName: 'setRelayer',
      args: [stranger.address, false],
    })
  ).rejects.toThrow();
  await expect(
    client.simulateContract({
      account: stranger,
      address: result.router,
      abi: sponsorRouterAbi,
      functionName: 'initialize',
      args: [stranger.address, [], []],
    })
  ).rejects.toThrow();
  await expect(
    deployInstanceRouter({ client, wallet, referenceRouter, relayers: [zeroAddress] })
  ).rejects.toThrow('nonzero');
  await expect(
    deployInstanceRouter({
      client,
      wallet,
      referenceRouter,
      relayers: [stranger.address, stranger.address],
    })
  ).rejects.toThrow('twice');
}, 60_000);
