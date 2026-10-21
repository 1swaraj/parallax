import { getChain, getDeployment, getMediaStore, getMirrorDeployment } from '@lens-monad/protocol';
import { defineChain, type Chain } from 'viem';

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const IS_LOCAL = CHAIN_ID === 31337;

/**
 * Mirror mode (README): a read-only client of the chain's mirror of Lens Chain, whose Lens data is copied from Lens
 * Chain, where it's still written. Nothing here writes: no posting, following, blocking, likes, sign-up or settings
 * that write, and signing in is optional. Its indexer runs in mirror mode too. Read at build time.
 */
export const MIRROR = process.env.NEXT_PUBLIC_MIRROR === 'true';

const baseChain = getChain(CHAIN_ID);
// Chain identity is fixed per build. Runtime RPCs and explorer links come from instance config.
export const chain: Chain = defineChain(baseChain);

export const deployment = MIRROR ? getMirrorDeployment(CHAIN_ID) : getDeployment(CHAIN_ID);
export const contracts = deployment.contracts;
/** Where post images are stored, or null on chains MediaStore isn't deployed on: images are off there. */
export const mediaStore = getMediaStore(CHAIN_ID);

/** X's limit. It also bounds what the relayer pays per post: the text is stored on-chain. */
export const MAX_POST_CHARACTERS = 280;
export const MAX_NAME_CHARACTERS = 64;
export const MAX_BIO_CHARACTERS = 280;
