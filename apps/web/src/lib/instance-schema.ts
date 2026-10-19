import { z } from 'zod';
import { getChain, getDeployment } from '@lens-monad/protocol';
import { APP_NAME, APP_TAGLINE } from './brand';
import { CHAIN_ID } from './config';
import { ModerationPolicy } from './moderation-policy';

const url = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Use an HTTP or HTTPS URL');
const optionalUrl = z.union([url, z.literal('')]);
const count = z.number().int().positive().max(1_000_000_000);
const gas = z.string().regex(/^[1-9][0-9]{0,24}$/, 'Use a positive number of gas units');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color');
export const InstanceConfig = z
  .object({
    appName: z.string().trim().min(1).max(64).default(APP_NAME),
    tagline: z.string().trim().min(1).max(180).default(APP_TAGLINE),
    logoUrl: optionalUrl.default(''),
    iconUrl: optionalUrl.default(''),
    accentColor: color.default('#6e54ff'),
    accentColorDark: color.default('#9f8fff'),
    defaultTheme: z.enum(['light', 'dark', 'system']).default('light'),
    appUrl: optionalUrl.default(''),
    publicRpcUrl: url.default(getChain(CHAIN_ID).rpcUrls.default.http[0]!),
    serverRpcUrl: optionalUrl.default(''),
    explorerUrl: optionalUrl.default(getChain(CHAIN_ID).blockExplorers?.default.url ?? ''),
    indexerUrl: optionalUrl.default(CHAIN_ID === 31337 ? 'http://127.0.0.1:42069' : ''),
    sponsorRouter: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .default(getDeployment(CHAIN_ID).contracts.SponsorRouter),
    relayPaused: z.boolean().default(false),
    sponsorGasBudgetPerHour: gas.nullable().default(null),
    sponsorMaxGasPerTx: gas.default('1500000'),
    sponsorMaxGasPerSignup: gas.default('3000000'),
    relayRateLimitPerMinute: count.default(30),
    signupRateLimitPerHour: count.default(3),
    signupRateLimitPerIpPerHour: count.default(10),
    sponsorSignupsPerHour: count.default(200),
    likeRateLimitPerMinute: count.default(60),
    relayerMinBalanceMon: z.number().positive().max(1_000_000_000).default(5),
    indexerMaxLagBlocks: count.default(50),
    emailFrom: z.union([z.string().email(), z.literal('')]).default(''),
    emailDomain: z
      .string()
      .max(253)
      .regex(/^$|^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/)
      .default(''),
    userEmailEnabled: z.boolean().default(false),
    moderation: ModerationPolicy.default({}),
  })
  .strict();
export type InstanceConfig = z.infer<typeof InstanceConfig>;
export const CONFIG_ENV = {
  appName: ['APP_NAME'],
  tagline: ['APP_TAGLINE'],
  logoUrl: ['APP_LOGO_URL'],
  iconUrl: ['APP_ICON_URL'],
  accentColor: ['APP_ACCENT_COLOR'],
  accentColorDark: ['APP_ACCENT_COLOR_DARK'],
  defaultTheme: ['APP_DEFAULT_THEME'],
  appUrl: ['APP_URL', 'NEXT_PUBLIC_APP_URL'],
  publicRpcUrl: ['NEXT_PUBLIC_RPC_URL'],
  serverRpcUrl: ['RPC_URL'],
  explorerUrl: ['NEXT_PUBLIC_EXPLORER_URL'],
  indexerUrl: ['INDEXER_URL'],
  sponsorRouter: ['SPONSOR_ROUTER_ADDRESS'],
  relayPaused: ['RELAY_PAUSED'],
  sponsorGasBudgetPerHour: ['SPONSOR_GAS_BUDGET_PER_HOUR'],
  sponsorMaxGasPerTx: ['SPONSOR_MAX_GAS_PER_TX'],
  sponsorMaxGasPerSignup: ['SPONSOR_MAX_GAS_PER_SIGNUP'],
  relayRateLimitPerMinute: ['RELAY_RATE_LIMIT_PER_MINUTE'],
  signupRateLimitPerHour: ['SIGNUP_RATE_LIMIT_PER_HOUR'],
  signupRateLimitPerIpPerHour: ['SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR'],
  sponsorSignupsPerHour: ['SPONSOR_SIGNUPS_PER_HOUR'],
  likeRateLimitPerMinute: ['LIKE_RATE_LIMIT_PER_MINUTE'],
  relayerMinBalanceMon: ['RELAYER_MIN_BALANCE_MON'],
  indexerMaxLagBlocks: ['INDEXER_MAX_LAG_BLOCKS'],
  emailFrom: ['RESEND_FROM_ADDRESS'],
  emailDomain: ['RESEND_DOMAIN'],
  userEmailEnabled: ['USER_EMAIL_ENABLED'],
  moderation: [],
} as const satisfies Record<keyof InstanceConfig, readonly string[]>;

export function resolveConfig(
  values: Record<string, unknown>,
  env: Record<string, string | undefined>
): InstanceConfig {
  const input = { ...values };
  const defaults = InstanceConfig.parse({});
  for (const [key, names] of Object.entries(CONFIG_ENV)) {
    const value = names.map((name) => env[name]).find((v) => v !== undefined && v !== '');
    if (value === undefined) continue;
    const sample = defaults[key as keyof InstanceConfig];
    input[key] =
      typeof sample === 'boolean'
        ? ['true', '1'].includes(value.trim().toLowerCase())
        : typeof sample === 'number'
          ? Number(value)
          : key.startsWith('sponsor') && key.includes('Gas')
            ? value.trim().replaceAll('_', '')
            : value;
  }
  const parsed = InstanceConfig.safeParse(input);
  if (!parsed.success) {
    // Name the bootstrap variable as well as the runtime field in operator errors.
    throw new z.ZodError(
      parsed.error.issues.map((issue) => {
        const names = CONFIG_ENV[issue.path[0] as keyof typeof CONFIG_ENV];
        return { ...issue, message: names ? `${names[0]}: ${issue.message}` : issue.message };
      })
    );
  }
  return parsed.data;
}

export type PublicConfig = Pick<
  InstanceConfig,
  | 'appName'
  | 'tagline'
  | 'logoUrl'
  | 'iconUrl'
  | 'accentColor'
  | 'accentColorDark'
  | 'defaultTheme'
  | 'appUrl'
  | 'publicRpcUrl'
  | 'explorerUrl'
  | 'sponsorRouter'
> & { walletConnectProjectId: string; emailEnabled: boolean };
export function publicConfig(
  config: InstanceConfig,
  walletConnectProjectId = '',
  emailEnabled = false
): PublicConfig {
  const {
    appName,
    tagline,
    logoUrl,
    iconUrl,
    accentColor,
    accentColorDark,
    defaultTheme,
    appUrl,
    publicRpcUrl,
    explorerUrl,
    sponsorRouter,
  } = config;
  return {
    appName,
    tagline,
    logoUrl,
    iconUrl,
    accentColor,
    accentColorDark,
    defaultTheme,
    appUrl,
    publicRpcUrl,
    explorerUrl,
    sponsorRouter,
    walletConnectProjectId,
    emailEnabled,
  };
}
