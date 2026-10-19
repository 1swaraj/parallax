'use client';

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { ModalsProvider } from '@/components/modals';
import { setDefaultTheme } from '@/components/theme';
import { ToastProvider } from '@/components/toast';
import { createWagmiConfig } from '@/lib/wagmi';
import { RuntimeConfigContext } from '@/lib/runtime-config';
import type { PublicConfig } from '@/lib/instance-schema';

function RuntimeProviders({ children, config }: { children: ReactNode; config: PublicConfig }) {
  const { data: runtime } = useQuery({
    queryKey: ['instance-config'],
    initialData: config,
    staleTime: 0,
    refetchInterval: 10_000,
    queryFn: async () => {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('Could not refresh instance config');
      return response.json() as Promise<PublicConfig>;
    },
  });
  useEffect(() => {
    document.documentElement.style.setProperty('--instance-accent', runtime.accentColor);
    document.documentElement.style.setProperty('--instance-accent-dark', runtime.accentColorDark);
    setDefaultTheme(runtime.defaultTheme);
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach((link) => {
      link.href = runtime.iconUrl || '/icon';
    });
  }, [runtime.accentColor, runtime.accentColorDark, runtime.defaultTheme, runtime.iconUrl]);
  const wagmiConfig = useMemo(
    () => createWagmiConfig(runtime),
    [runtime.publicRpcUrl, runtime.walletConnectProjectId, runtime.appName, runtime.iconUrl]
  );
  return (
    <RuntimeConfigContext.Provider value={runtime}>
      <WagmiProvider config={wagmiConfig}>
        <ToastProvider>
          <ModalsProvider>{children}</ModalsProvider>
        </ToastProvider>
      </WagmiProvider>
    </RuntimeConfigContext.Provider>
  );
}

export function Providers({ children, config }: { children: ReactNode; config: PublicConfig }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <RuntimeProviders config={config}>{children}</RuntimeProviders>
    </QueryClientProvider>
  );
}
