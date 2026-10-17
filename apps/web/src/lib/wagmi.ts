import { createConfig, createConnector, http } from 'wagmi';
import { injected, mock } from 'wagmi/connectors';
import type { Address } from 'viem';
import { chain, IS_LOCAL } from './config';

// Anvil's 6th to 8th accounts, unlocked on the local node, which signs for them: dev wallets that need no
// extension. The first four are the deployer, the proxy admin, the claims key and the relayer.
const DEV_ACCOUNTS: Address[] = [
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
];

function devWallet(address: Address, index: number) {
  return createConnector((config) => ({
    ...mock({ accounts: [address], features: { reconnect: true } })(config),
    id: `dev-wallet-${index}`,
    name: `Dev wallet ${index} (${address.slice(0, 6)}…)`,
  }));
}

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    injected(),
    ...(IS_LOCAL ? DEV_ACCOUNTS.map((address, i) => devWallet(address, i + 1)) : []),
  ],
  transports: { [chain.id]: http() },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
