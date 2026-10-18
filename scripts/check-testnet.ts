// Read-only deployment smoke check. Never signs, sends transactions, or submits explorer verification.
import assert from 'node:assert/strict';
import { createPublicClient, http, keccak256 } from 'viem';
import { getChain, getDeployment, namespaceAbi, sponsorRouterAbi } from '../packages/protocol/src';
import release from '../packages/protocol/deployments/10143-release.json';

async function main() {
  const client = createPublicClient({
    chain: getChain(10143),
    transport: http(process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'),
  });
  assert.equal(await client.getChainId(), 10143, 'RPC must be Monad testnet');
  const { contracts, deploymentBlock } = getDeployment(10143);
  for (const [name, address] of Object.entries(contracts)) {
    const code = await client.getCode({ address });
    assert.ok(code && code !== '0x', `${name} has no code at ${address}`);
    assert.equal(
      keccak256(code),
      release.clientContractCodeHashes[name as keyof typeof release.clientContractCodeHashes],
      `${name} proxy bytecode differs from the release`
    );
    console.log(`${name}: ${address}`);
  }
  assert.equal(
    await client.readContract({
      address: contracts.LensGlobalNamespace,
      abi: namespaceAbi,
      functionName: 'getNamespace',
    }),
    'lens'
  );
  assert.equal(
    (
      await client.readContract({
        address: contracts.SponsorRouter,
        abi: sponsorRouterAbi,
        functionName: 'owner',
      })
    ).toLowerCase(),
    release.owner.toLowerCase()
  );
  const relayers = await client.readContract({
    address: contracts.SponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'getRelayers',
  });
  console.log(
    `Chain 10143; index from block ${deploymentBlock}; ${relayers.length} relayer(s) allowlisted.`
  );
  if (relayers.length === 0)
    console.log(
      'Sponsorship is intentionally pending. Use wallet-paid writes until relayers are configured.'
    );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
