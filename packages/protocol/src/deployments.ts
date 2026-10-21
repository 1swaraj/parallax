import type { Address } from 'viem';
import { ADDRESS_BOOKS, MIRROR_ADDRESS_BOOKS } from './address-books';

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

/**
 * The read-only mirror of Lens Chain (README, Mirror mode): a Lens deployment in migration mode that is never sealed,
 * the importers behind its canonical proxies. Its address book is a whole deployment's, plus the deployer of the
 * account importers.
 */
export type MirrorDeployment = Deployment & {
  contracts: Deployment['contracts'] & { MigrationAccountDeployer: Address };
};

/**
 * The mirrors' address books, in packages/protocol/deployments/mirror (`pnpm sync:contracts --mirror`). A chain's
 * mirror that isn't deployed yet has a placeholder book, which says so.
 */
const MIRROR_BOOKS: ({ chainId: number; placeholder?: string } & Record<string, unknown>)[] =
  MIRROR_ADDRESS_BOOKS;

export function getMirrorDeployment(chainId: number): MirrorDeployment {
  const book = MIRROR_BOOKS.find((candidate) => candidate.chainId === chainId);
  if (!book) {
    throw new Error(
      `No mirror of Lens Chain is known on chain ${chainId} (known: ${MIRROR_BOOKS.map((mirror) => mirror.chainId).join(', ')})`
    );
  }
  if (book.placeholder) {
    throw new Error(book.placeholder);
  }
  const deployment = parse(book as AddressBook);
  const deployer = (book.MigrationAccountDeployer as { address?: Address } | undefined)?.address;
  if (!deployer) {
    throw new Error(
      `The mirror's address book of chain ${chainId} has no MigrationAccountDeployer`
    );
  }
  return {
    ...deployment,
    contracts: { ...deployment.contracts, MigrationAccountDeployer: deployer },
  };
}
