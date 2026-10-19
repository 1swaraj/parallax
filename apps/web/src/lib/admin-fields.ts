import type { InstanceConfig } from './instance-schema';
export type ConfigField = {
  key: keyof InstanceConfig;
  label: string;
  help?: string;
  kind?: 'number' | 'boolean' | 'theme';
};
export const CONFIG_GROUPS: Record<string, { title: string; fields: ConfigField[] }> = {
  branding: {
    title: 'Branding',
    fields: [
      { key: 'appName', label: 'App name' },
      { key: 'tagline', label: 'Tagline' },
      {
        key: 'logoUrl',
        label: 'Logo URL',
        help: 'Public HTTP(S) image URL. Leave blank to use the instance name.',
      },
      {
        key: 'iconUrl',
        label: 'Icon URL',
        help: 'Public HTTP(S) image URL. Leave blank for the default mark.',
      },
      {
        key: 'accentColor',
        label: 'Accent color (light)',
        help: 'Six-digit hex color, for example #6e54ff.',
      },
      { key: 'accentColorDark', label: 'Accent color (dark)' },
      { key: 'defaultTheme', label: 'Default appearance', kind: 'theme' },
    ],
  },
  network: {
    title: 'Network',
    fields: [
      {
        key: 'appUrl',
        label: 'App URL',
        help: 'Public origin used for SIWE and email links, for example https://social.example.com.',
      },
      {
        key: 'publicRpcUrl',
        label: 'Browser RPC URL',
        help: 'Public: sent to browsers. Do not use a private provider key here.',
      },
      {
        key: 'serverRpcUrl',
        label: 'Server RPC URL',
        help: 'Optional server-only endpoint. Falls back to the browser RPC.',
      },
      { key: 'explorerUrl', label: 'Explorer URL' },
      {
        key: 'indexerUrl',
        label: 'Indexer URL',
        help: 'The existing indexer’s base URL. Reads stream through /indexer.',
      },
      {
        key: 'sponsorRouter',
        label: 'SponsorRouter address',
        help: 'Defaults to this chain’s address book. Existing accounts may need to authorize a different router.',
      },
    ],
  },
  sponsorship: {
    title: 'Sponsorship & limits',
    fields: [
      {
        key: 'relayPaused',
        label: 'Pause sponsored actions',
        kind: 'boolean',
        help: 'Applies within 10 seconds across app instances. Users can still pay with their wallets.',
      },
      {
        key: 'sponsorGasBudgetPerHour',
        label: 'Gas budget per hour',
        help: 'Gas units across all relayers per UTC clock hour. Required outside local development. Leave blank to disable sponsorship unless an env override supplies a budget.',
      },
      {
        key: 'sponsorMaxGasPerTx',
        label: 'Maximum gas per action',
        help: 'Gas units. Default: 1500000.',
      },
      {
        key: 'sponsorMaxGasPerSignup',
        label: 'Maximum gas per signup',
        help: 'Gas units. Default: 3000000.',
      },
      {
        key: 'relayRateLimitPerMinute',
        label: 'Sponsored actions per account per minute',
        kind: 'number',
        help: 'Default: 30.',
      },
      {
        key: 'signupRateLimitPerHour',
        label: 'Signups per wallet per hour',
        kind: 'number',
        help: 'Default: 3.',
      },
      {
        key: 'signupRateLimitPerIpPerHour',
        label: 'Signups per IP per hour',
        kind: 'number',
        help: 'IPv6 addresses share a /64. Default: 10.',
      },
      {
        key: 'sponsorSignupsPerHour',
        label: 'Signups across the instance per hour',
        kind: 'number',
        help: 'Default: 200.',
      },
      {
        key: 'likeRateLimitPerMinute',
        label: 'Likes and unlikes per account per minute',
        kind: 'number',
        help: 'Default: 60.',
      },
      {
        key: 'relayerMinBalanceMon',
        label: 'Minimum relayer balance (MON)',
        kind: 'number',
        help: 'Health threshold and funding reminder. Default: 5 MON.',
      },
      {
        key: 'indexerMaxLagBlocks',
        label: 'Maximum indexer lag (blocks)',
        kind: 'number',
        help: 'Health threshold. Default: 50 blocks.',
      },
    ],
  },
  email: {
    title: 'Email',
    fields: [
      {
        key: 'emailFrom',
        label: 'From address',
        help: 'An email address on a verified Resend domain.',
      },
      {
        key: 'emailDomain',
        label: 'Verified domain',
        help: 'For example social.example.com. Check DNS verification below.',
      },
      {
        key: 'userEmailEnabled',
        label: 'Offer user email digests',
        kind: 'boolean',
        help: 'Off by default. Requires Resend, a from address and the public app URL. Users must confirm their email.',
      },
    ],
  },
};
