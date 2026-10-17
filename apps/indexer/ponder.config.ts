import {
  accountAbi,
  accountBlockingRuleAbi,
  accountFactoryAbi,
  feedAbi,
  getDeployment,
  graphAbi,
  namespaceAbi,
} from '@lens-monad/protocol';
import { createConfig, factory } from 'ponder';
import { getAbiItem } from 'viem';

// Environment (see .env.example):
//   PONDER_CHAIN_ID        31337 (local node, the default), 10143 (Monad testnet) or 143 (Monad mainnet). The chain's
//                          address book must be in @lens-monad/protocol (getDeployment).
//   PONDER_RPC_URL         HTTP RPC URL(s), comma-separated to spread the load. Required off the local node. Use a paid
//                          RPC in production: Monad's public testnet RPC (testnet-rpc.monad.xyz) answers 429 above
//                          25 requests/s per IP, and refuses eth_getLogs over more than 100 blocks.
//   PONDER_GET_LOGS_RANGE  Blocks per eth_getLogs request (default 100, what Monad's public testnet RPC accepts).
//                          Raise it to your provider's limit to backfill faster, but not above: with a set range,
//                          Ponder fails on range errors instead of retrying with a smaller one.
//   DATABASE_URL           Postgres in production, PGlite in .ponder/ otherwise.

const LOCAL_CHAIN_ID = 31337;
const chainId = Number(process.env.PONDER_CHAIN_ID ?? LOCAL_CHAIN_ID);
const isLocal = chainId === LOCAL_CHAIN_ID;
const { contracts, deploymentBlock } = getDeployment(chainId);
const startBlock = deploymentBlock;

function rpcUrls() {
  const urls = (process.env.PONDER_RPC_URL ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
  if (urls.length === 0 && !isLocal) {
    throw new Error(`PONDER_RPC_URL is required to index chain ${chainId}`);
  }
  return urls.length === 0 ? 'http://127.0.0.1:8545' : urls.length === 1 ? urls[0]! : urls;
}

function getLogsRange() {
  const range = Number(process.env.PONDER_GET_LOGS_RANGE ?? 100);
  if (!Number.isInteger(range) || range < 1) {
    throw new Error(`PONDER_GET_LOGS_RANGE must be a positive integer, got ${range}`);
  }
  return range;
}

export default createConfig({
  database: process.env.DATABASE_URL
    ? { kind: 'postgres', connectionString: process.env.DATABASE_URL }
    : undefined,
  chains: {
    monad: {
      id: chainId,
      rpc: rpcUrls(),
      ethGetLogsBlockRange: getLogsRange(),
      // Monad's blocks are ~0.4s: polling every second picks up 2 or 3 at a time.
      pollingInterval: isLocal ? 250 : 1000,
      // A restarted local node reuses chain 31337 with different blocks, so its responses can't be cached.
      cacheRpcRequests: !isLocal,
    },
  },
  contracts: {
    AccountFactory: {
      chain: 'monad',
      abi: accountFactoryAbi,
      address: contracts.AccountFactory,
      startBlock,
    },
    Account: {
      chain: 'monad',
      abi: accountAbi,
      address: factory({
        address: contracts.AccountFactory,
        event: getAbiItem({ abi: accountFactoryAbi, name: 'Lens_Account_Created' }),
        parameter: 'account',
      }),
      startBlock,
    },
    Feed: { chain: 'monad', abi: feedAbi, address: contracts.LensGlobalFeed, startBlock },
    Graph: { chain: 'monad', abi: graphAbi, address: contracts.LensGlobalGraph, startBlock },
    Namespace: {
      chain: 'monad',
      abi: namespaceAbi,
      address: contracts.LensGlobalNamespace,
      startBlock,
    },
    AccountBlockingRule: {
      chain: 'monad',
      abi: accountBlockingRuleAbi,
      address: contracts.AccountBlockingRule,
      startBlock,
    },
  },
});
