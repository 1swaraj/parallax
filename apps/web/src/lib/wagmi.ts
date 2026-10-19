import { createConfig, createConnector, http, type CreateConnectorFn } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { brandCopy } from './brand';
import { chain } from './config';
import { passkeyConnectors } from './passkey';
import { defineChain } from 'viem';
import type { PublicConfig } from './instance-schema';

/**
 * WalletConnect, for phones and wallets without an extension, when a project ID is set. In the browser only: the
 * config sets connectors up as it's created, and WalletConnect's provider needs browser storage.
 *
 * Its provider (~300 KB compressed) loads once someone picks it, or on load when it's the wallet they used last: wagmi
 * asks every connector for its provider as the page loads, which would otherwise load it for every visitor.
 */
function walletConnectConnector(runtime: PublicConfig): CreateConnectorFn[] {
  const WALLETCONNECT_PROJECT_ID = runtime.walletConnectProjectId;
  if (!WALLETCONNECT_PROJECT_ID || typeof window === 'undefined') {
    return [];
  }
  const origin = window.location.origin;
  const create = walletConnect({
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: runtime.appName,
      description: brandCopy(runtime).APP_DESCRIPTION,
      url: origin,
      icons: [runtime.iconUrl || `${origin}/icon`],
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

export function createWagmiConfig(runtime: PublicConfig) {
  const runtimeChain = defineChain({
    ...chain,
    rpcUrls: { default: { http: [runtime.publicRpcUrl] } },
  });
  return createConfig({
    chains: [runtimeChain],
    connectors: [
      injected(),
      // Passkey accounts, in browsers with WebAuthn, unless NEXT_PUBLIC_PASSKEYS is false.
      ...(process.env.NEXT_PUBLIC_PASSKEYS !== 'false' && typeof PublicKeyCredential === 'function'
        ? passkeyConnectors()
        : []),
      ...walletConnectConnector(runtime),
    ],
    transports: { [chain.id]: http(runtime.publicRpcUrl) },
    ssr: true,
  });
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof createWagmiConfig>;
  }
}
