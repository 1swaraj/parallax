'use client';
import { createContext, useContext } from 'react';
import { defineChain, type Address } from 'viem';
import { InstanceConfig, publicConfig, type PublicConfig } from './instance-schema';
import { brandCopy } from './brand';
import { chain, contracts } from './config';
export const RuntimeConfigContext = createContext<PublicConfig>(
  publicConfig(InstanceConfig.parse({}))
);
export function useInstanceConfig() {
  return useContext(RuntimeConfigContext);
}
export function useBrand() {
  return brandCopy(useInstanceConfig());
}
export function useNetwork() {
  const config = useInstanceConfig();
  return {
    chain: defineChain({ ...chain, rpcUrls: { default: { http: [config.publicRpcUrl] } } }),
    contracts: { ...contracts, SponsorRouter: config.sponsorRouter as Address },
    EXPLORER_URL: config.explorerUrl || null,
    explorerAddressUrl: (address: string) =>
      config.explorerUrl ? `${config.explorerUrl.replace(/\/+$/, '')}/address/${address}` : null,
  };
}
