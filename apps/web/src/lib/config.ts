import { getChain, getDeployment, getMediaStore } from '@lens-monad/protocol';
import { defineChain, type Chain } from 'viem';

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const IS_LOCAL = CHAIN_ID === 31337;

const baseChain = getChain(CHAIN_ID);
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? baseChain.rpcUrls.default.http[0]!;

export const chain: Chain = defineChain({ ...baseChain, rpcUrls: { default: { http: [rpcUrl] } } });

/**
 * The block explorer the app links to: NEXT_PUBLIC_EXPLORER_URL, else Monadscan on mainnet and testnet
 * (https://docs.monad.xyz/developer-essentials/network-information, .../testnets). None on the local chain.
 */
const DEFAULT_EXPLORERS: Partial<Record<number, string>> = {
  143: 'https://monadscan.com',
  10143: 'https://testnet.monadscan.com',
};
export const EXPLORER_URL =
  (process.env.NEXT_PUBLIC_EXPLORER_URL || DEFAULT_EXPLORERS[CHAIN_ID])?.replace(/\/+$/, '') ||
  null;

export function explorerAddressUrl(address: string) {
  return EXPLORER_URL ? `${EXPLORER_URL}/address/${address}` : null;
}

export const deployment = getDeployment(CHAIN_ID);
export const contracts = deployment.contracts;
/** Where post images are stored, or null on chains MediaStore isn't deployed on: images are off there. */
export const mediaStore = getMediaStore(CHAIN_ID);

/** X's limit. It also bounds what the relayer pays per post: the text is stored on-chain. */
export const MAX_POST_CHARACTERS = 280;
export const MAX_NAME_CHARACTERS = 64;
export const MAX_BIO_CHARACTERS = 280;
