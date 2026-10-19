import { contracts } from '../config';
import { currentConfig } from './instance-config';
export const runtimeContracts = new Proxy(contracts, {
  get(target, key: keyof typeof contracts) {
    return key === 'SponsorRouter' ? currentConfig().sponsorRouter : target[key];
  },
});
