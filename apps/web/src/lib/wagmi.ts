import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { chain } from './config';

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [chain.id]: http() },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
