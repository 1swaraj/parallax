import { createConfig, createConnector, http, type CreateConnectorFn } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { APP_DESCRIPTION, APP_NAME } from './brand';
import { chain } from './config';

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

/**
 * WalletConnect, for phones and wallets without an extension, when a project ID is set. In the browser only: the
 * config sets connectors up as it's created, and WalletConnect's provider needs browser storage.
 *
 * Its provider (~300 KB compressed) loads once someone picks it, or on load when it's the wallet they used last: wagmi
 * asks every connector for its provider as the page loads, which would otherwise load it for every visitor.
 */
function walletConnectConnector(): CreateConnectorFn[] {
  if (!WALLETCONNECT_PROJECT_ID || typeof window === 'undefined') {
    return [];
  }
  const origin = window.location.origin;
  const create = walletConnect({
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: APP_NAME,
      description: APP_DESCRIPTION,
      url: origin,
      icons: [`${origin}/icon.svg`],
    },
  });
  return [
    createConnector((config) => {
      const connector = create(config);
      let picked = false;
      const wanted = async () =>
        picked || (await config.storage?.getItem('recentConnectorId')) === connector.id;
      return {
        ...connector,
        async connect(parameters) {
          picked = true;
          return connector.connect.call(this, parameters);
        },
        // The connector's other methods reach the provider through this one.
        async getProvider(parameters) {
          return (await wanted()) ? connector.getProvider.call(this, parameters) : undefined;
        },
      } as typeof connector;
    }),
  ];
}

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected(), ...walletConnectConnector()],
  transports: { [chain.id]: http() },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
