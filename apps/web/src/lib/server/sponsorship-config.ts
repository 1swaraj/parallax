import { getAddress } from 'viem';
import { getInstanceConfig } from './instance-config';

/**
 * The instance's name and SponsorRouter, from the runtime instance config (SPONSOR_ROUTER_ADDRESS overrides it, and
 * the address book's router is the default).
 */
export async function getSponsorshipConfig() {
  const config = await getInstanceConfig();
  return { name: config.appName, sponsorRouter: getAddress(config.sponsorRouter) };
}
