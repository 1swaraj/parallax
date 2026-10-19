import { getChain } from '../src';
import { env } from 'node:process';

// Tests sign only with anvil keys. A fork can use the testnet address book on a loopback node.
const rpc = env.RPC_URL ?? 'http://127.0.0.1:8545';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(rpc).hostname)) {
  throw new Error('End-to-end tests require a loopback RPC');
}
export const localTestChain = {
  ...getChain(Number(env.E2E_CHAIN_ID ?? 31337)),
  rpcUrls: { default: { http: [rpc] } },
};
