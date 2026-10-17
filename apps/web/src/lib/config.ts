import { getChain, getDeployment } from '@lens-monad/protocol';
import { defineChain, type Chain } from 'viem';

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const IS_LOCAL = CHAIN_ID === 31337;

const baseChain = getChain(CHAIN_ID);
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? baseChain.rpcUrls.default.http[0]!;

export const chain: Chain = defineChain({ ...baseChain, rpcUrls: { default: { http: [rpcUrl] } } });

export const deployment = getDeployment(CHAIN_ID);
export const contracts = deployment.contracts;

/** X's limit. It also bounds what the relayer pays per post: the text is stored on-chain. */
export const MAX_POST_CHARACTERS = 280;
export const MAX_NAME_CHARACTERS = 64;
export const MAX_BIO_CHARACTERS = 280;
