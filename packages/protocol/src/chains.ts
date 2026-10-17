import { defineChain } from 'viem';
import { monad, monadTestnet } from 'viem/chains';

/** `anvil --network monad`: Monad's execution rules on chain 31337. */
export const monadLocal = defineChain({
  id: 31337,
  name: 'Monad (local)',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
});

export const CHAINS = {
  [monadLocal.id]: monadLocal,
  [monadTestnet.id]: monadTestnet,
  [monad.id]: monad,
} as const;

export function getChain(chainId: number) {
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) {
    throw new Error(`Unsupported chain ${chainId}`);
  }
  return chain;
}
