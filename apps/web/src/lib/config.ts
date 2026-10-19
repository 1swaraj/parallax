import { getChain, getDeployment, getMediaStore } from '@lens-monad/protocol';
import { defineChain, type Chain } from 'viem';

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const IS_LOCAL = CHAIN_ID === 31337;

const baseChain = getChain(CHAIN_ID);
// Chain identity is fixed per build. Runtime RPCs and explorer links come from instance config.
export const chain: Chain = defineChain(baseChain);

export const deployment = getDeployment(CHAIN_ID);
export const contracts = deployment.contracts;
/** Where post images are stored, or null on chains MediaStore isn't deployed on: images are off there. */
export const mediaStore = getMediaStore(CHAIN_ID);

/** X's limit. It also bounds what the relayer pays per post: the text is stored on-chain. */
export const MAX_POST_CHARACTERS = 280;
export const MAX_NAME_CHARACTERS = 64;
export const MAX_BIO_CHARACTERS = 280;
