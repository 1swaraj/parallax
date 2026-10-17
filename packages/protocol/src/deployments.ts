import type { Address } from 'viem';
import { ADDRESS_BOOKS } from './address-books';

/** The contracts the client calls or indexes, by their name in the deployment scripts' address book. */
export const CONTRACT_NAMES = [
  'AccountBlockingRule',
  'AccountFactory',
  'LensFactory',
  'LensGlobalFeed',
  'LensGlobalGraph',
  'LensGlobalNamespace',
  'ReferenceApp',
  'SponsorRouter',
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

export type Deployment = {
  chainId: number;
  /** The block the deployment started from, where indexers start. */
  deploymentBlock: number;
  contracts: Record<ContractName, Address>;
};

type AddressBook = { chainId: number; deploymentBlock: number } & Record<string, unknown>;

/**
 * Address books written by DeployMonad + DeployLaunch, one per chain in packages/protocol/deployments. To add a
 * chain, add its <chainId>.json there and run `pnpm sync:contracts` (or `pnpm sync:contracts --address-books`).
 */
const BOOKS: AddressBook[] = ADDRESS_BOOKS;

function parse(book: AddressBook): Deployment {
  const contracts = {} as Record<ContractName, Address>;
  for (const name of CONTRACT_NAMES) {
    const entry = book[name] as { address?: Address } | undefined;
    if (!entry?.address) {
      throw new Error(
        `The address book of chain ${book.chainId} has no ${name}. Was DeployLaunch run?`
      );
    }
    contracts[name] = entry.address;
  }
  return { chainId: book.chainId, deploymentBlock: book.deploymentBlock, contracts };
}

const DEPLOYMENTS = new Map(BOOKS.map((book) => [book.chainId, parse(book)]));

export function getDeployment(chainId: number): Deployment {
  const deployment = DEPLOYMENTS.get(chainId);
  if (!deployment) {
    throw new Error(
      `Lens isn't deployed on chain ${chainId} (known: ${[...DEPLOYMENTS.keys()].join(', ')})`
    );
  }
  return deployment;
}
