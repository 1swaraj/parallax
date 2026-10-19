import { z } from 'zod';
import { RE2JS } from 're2js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const ModerationPolicy = z
  .object({
    signupMode: z.enum(['open', 'invite', 'allowlist', 'token']).default('open'),
    turnstileEnabled: z.boolean().default(false),
    turnstileSiteKey: z.string().max(200).default(''),
    token: z
      .object({
        standard: z.enum(['erc20', 'erc721', 'erc1155']).default('erc20'),
        address: z.union([address, z.literal('')]).default(''),
        minimum: uint.refine((v) => BigInt(v) > 0n).default('1'),
        tokenId: uint.default('0'),
      })
      .strict()
      .default({}),
    externalAccounts: z.enum(['allow', 'approval', 'allowlist']).default('allow'),
    sponsorship: z.enum(['everyone', 'members', 'approved', 'nobody']).default('everyone'),
    cooldownHours: z.number().min(0).max(8760).default(0),
    cooldownAction: z.enum(['deny', 'limit']).default('deny'),
    homeFeed: z.enum(['network', 'members', 'curated']).default('network'),
    curatedAccounts: z.array(address).max(5000).default([]),
    memberRate: z.number().int().min(1).max(10000).default(30),
    newAccountRate: z.number().int().min(1).max(10000).default(5),
    approvedRate: z.number().int().min(1).max(10000).default(60),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.signupMode === 'token' && !/^0x[0-9a-fA-F]{40}$/.test(policy.token.address))
      ctx.addIssue({
        code: 'custom',
        path: ['token', 'address'],
        message: 'Set the token contract before enabling the token gate',
      });
    if (policy.turnstileEnabled && !policy.turnstileSiteKey)
      ctx.addIssue({
        code: 'custom',
        path: ['turnstileSiteKey'],
        message: 'Set a Turnstile site key before enabling the bot check',
      });
  });
export type ModerationPolicy = z.infer<typeof ModerationPolicy>;

export type ModeratedAccount = {
  account: string;
  owner: string | null;
  member: boolean;
  approved: boolean;
  hidden: boolean;
  suspended: boolean;
  sponsorRevoked: boolean;
  label: string | null;
  createdAt: number;
  reason: string;
};
export type ContentFilter = {
  id: string;
  kind: 'word' | 'link' | 'regex';
  pattern: string;
  action: 'block' | 'hide' | 'label';
  reason: string;
};
export type ModerationSnapshot = {
  accounts: Map<string, ModeratedAccount>;
  posts: Map<string, { action: 'hide' | 'label'; reason: string }>;
  filters: ContentFilter[];
  allowlist: Set<string>;
};
export function emptyModeration(): ModerationSnapshot {
  return { accounts: new Map(), posts: new Map(), filters: [], allowlist: new Set() };
}

export function allowedIdentity(snapshot: ModerationSnapshot, owner: string, account?: string) {
  return (
    snapshot.allowlist.has(owner.toLowerCase()) ||
    (!!account && snapshot.allowlist.has(account.toLowerCase()))
  );
}

/** Pure decisions are shared by session refresh, relay, and the server read layer. */
export function accessDecision(
  policy: ModerationPolicy,
  state: ModerationSnapshot,
  owner: string,
  account?: string
): string | null {
  const status = account ? state.accounts.get(account.toLowerCase()) : undefined;
  if (status?.suspended || state.accounts.get(owner.toLowerCase())?.suspended)
    return 'This account is suspended on this instance';
  if (!account || status?.member) return null;
  if (policy.externalAccounts === 'approval' && !status?.approved)
    return 'This account needs moderator approval on this instance';
  if (policy.externalAccounts === 'allowlist' && !allowedIdentity(state, owner, account))
    return 'This account is not on this instance’s allowlist';
  return null;
}

export function sponsorshipDecision(
  policy: ModerationPolicy,
  status?: ModeratedAccount,
  now = Date.now()
): string | null {
  if (status?.sponsorRevoked)
    return 'Sponsorship was revoked for this account. You can pay from your wallet.';
  if (
    policy.sponsorship === 'nobody' ||
    (policy.sponsorship === 'members' && !status?.member) ||
    (policy.sponsorship === 'approved' && !status?.approved)
  )
    return 'This instance does not sponsor this account. You can pay from your wallet.';
  if (isNewAccount(policy, status, now) && policy.cooldownAction === 'deny')
    return 'This account is in the sponsorship cooldown. You can pay from your wallet.';
  return null;
}
export function isNewAccount(
  policy: ModerationPolicy,
  status?: ModeratedAccount,
  now = Date.now()
) {
  return (
    policy.cooldownHours > 0 &&
    (!status || now - status.createdAt < policy.cooldownHours * 3600_000)
  );
}
export function accountRate(policy: ModerationPolicy, status?: ModeratedAccount, now = Date.now()) {
  return isNewAccount(policy, status, now)
    ? policy.newAccountRate
    : status?.approved
      ? policy.approvedRate
      : policy.memberRate;
}

const expressions = new Map<string, RE2JS>();
export function matchesFilter(filter: ContentFilter, text: string): boolean {
  if (filter.kind === 'word')
    return text.toLocaleLowerCase().includes(filter.pattern.toLocaleLowerCase());
  if (filter.kind === 'regex') {
    let regex = expressions.get(filter.pattern);
    if (!regex) {
      if (expressions.size >= 200) expressions.clear();
      regex = RE2JS.compile(filter.pattern, RE2JS.CASE_INSENSITIVE);
      expressions.set(filter.pattern, regex);
    }
    return regex.test(text);
  }
  const host = filter.pattern.toLowerCase().replace(/^www\./, '');
  return (text.match(/https?:\/\/[^\s<>]+/gi) ?? []).some((link) => {
    try {
      const domain = new URL(link).hostname.toLowerCase().replace(/^www\./, '');
      return domain === host || domain.endsWith(`.${host}`);
    } catch {
      return false;
    }
  });
}
export function contentDecision(filters: ContentFilter[], text: string) {
  const matches = filters.filter((filter) => matchesFilter(filter, text.slice(0, 25000)));
  return {
    blocked: matches.some((f) => f.action === 'block'),
    hidden: matches.some((f) => f.action === 'hide' || f.action === 'block'),
    label: matches.find((f) => f.action === 'label')?.reason ?? null,
  };
}

export const FilterInput = z
  .object({
    kind: z.enum(['word', 'link', 'regex']),
    pattern: z.string().trim().min(1).max(200),
    action: z.enum(['block', 'hide', 'label']),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((filter, ctx) => {
    if (
      filter.kind === 'link' &&
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(filter.pattern)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Use a domain such as example.com',
        path: ['pattern'],
      });
    if (filter.kind === 'regex') {
      // RE2 evaluates in linear time; backreferences and lookaround are deliberately unsupported.
      try {
        RE2JS.compile(filter.pattern, RE2JS.CASE_INSENSITIVE);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid RE2 regex (no backreferences or lookaround)',
          path: ['pattern'],
        });
      }
    }
  });
