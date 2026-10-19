import { APP_NAME } from './brand';

/** `todo`: the instance doesn't work fully without it. `optional`: a choice, shown with its default. */
export type ChecklistStatus = 'done' | 'todo' | 'optional';
export type ChecklistItem = {
  id: string;
  label: string;
  detail: string;
  status: ChecklistStatus;
  href: string;
};

export type ChecklistInput = {
  config: {
    appName: string;
    logoUrl: string;
    iconUrl: string;
    indexerUrl: string;
    emailFrom: string;
    moderation: { signupMode: string; sponsorship: string };
  };
  health: {
    paused: boolean;
    relayers: { allowlisted: boolean | null; low: boolean }[];
    indexer: { lag: number | null };
    gas: { budgetPerHour: string | null };
  };
  resendKeySet: boolean;
  teamSize: number;
};

/** What an owner or admin still has to do, from settings and health only: no extra RPC calls. */
export function setupChecklist({ config, health, resendKeySet, teamSize }: ChecklistInput) {
  const items: ChecklistItem[] = [];

  items.push(
    !config.indexerUrl
      ? {
          id: 'network',
          label: 'Connect an indexer',
          detail: 'Feeds, profiles and search read from it. Set its URL in Network.',
          status: 'todo',
          href: '/admin/network',
        }
      : health.indexer.lag === null
        ? {
            id: 'network',
            label: 'Connect an indexer',
            detail: "The indexer isn't responding. Check its URL in Network and its /ready.",
            status: 'todo',
            href: '/admin/network',
          }
        : {
            id: 'network',
            label: 'Connect an indexer',
            detail: `Connected, ${health.indexer.lag} blocks behind.`,
            status: 'done',
            href: '/admin/network',
          }
  );

  const sponsorship = {
    id: 'sponsorship',
    label: 'Pay network fees for your users',
    href: '/admin/sponsorship',
  };
  const unchecked = health.relayers.filter((relayer) => relayer.allowlisted === null).length;
  const notAllowlisted = health.relayers.filter((relayer) => relayer.allowlisted === false).length;
  const low = health.relayers.filter((relayer) => relayer.low).length;
  if (health.paused) {
    items.push({
      ...sponsorship,
      detail:
        'Paused: users pay from their own wallets. Add relayer keys and an hourly gas budget, then unpause.',
      status: 'optional',
    });
  } else if (health.relayers.length === 0) {
    items.push({
      ...sponsorship,
      detail:
        'Add or generate a relayer key, fund it with MON and allowlist it on the SponsorRouter.',
      status: 'todo',
    });
  } else if (unchecked > 0) {
    items.push({
      ...sponsorship,
      detail: `Couldn't check ${unchecked === 1 ? 'the relayer' : `${unchecked} relayers`} on the SponsorRouter: is the server RPC reachable? See Network.`,
      status: 'todo',
    });
  } else if (notAllowlisted > 0) {
    items.push({
      ...sponsorship,
      detail: `${notAllowlisted} relayer${notAllowlisted === 1 ? " isn't" : "s aren't"} allowlisted on the SponsorRouter yet.`,
      status: 'todo',
    });
  } else if (health.gas.budgetPerHour === null) {
    items.push({
      ...sponsorship,
      detail: 'Set an hourly gas budget: sponsored actions are refused without one.',
      status: 'todo',
    });
  } else if (low > 0) {
    items.push({
      ...sponsorship,
      detail: `${low} relayer${low === 1 ? ' is' : 's are'} low on MON. Top up before sponsored actions fail.`,
      status: 'todo',
    });
  } else {
    items.push({
      ...sponsorship,
      detail: `${health.relayers.length} relayer${health.relayers.length === 1 ? '' : 's'} funded and allowlisted.`,
      status: 'done',
    });
  }

  const branded = config.appName !== APP_NAME || !!config.logoUrl || !!config.iconUrl;
  items.push({
    id: 'branding',
    label: 'Make it yours',
    detail: branded ? `Branded as ${config.appName}.` : `Using the default ${APP_NAME} brand.`,
    status: branded ? 'done' : 'optional',
    href: '/admin/branding',
  });

  const email = resendKeySet && !!config.emailFrom;
  items.push({
    id: 'email',
    label: 'Set up email',
    detail: email
      ? `Sending from ${config.emailFrom}.`
      : 'Add a Resend key and from-address for operator alerts and user digests.',
    status: email ? 'done' : 'optional',
    href: '/admin/email',
  });

  const defaults =
    config.moderation.signupMode === 'open' && config.moderation.sponsorship === 'everyone';
  items.push({
    id: 'moderation',
    label: 'Choose who can join',
    detail: `Sign-ups: ${config.moderation.signupMode}. Sponsored: ${config.moderation.sponsorship}.`,
    status: defaults ? 'optional' : 'done',
    href: '/admin/moderation',
  });

  items.push({
    id: 'team',
    label: 'Add your team',
    detail:
      teamSize > 1
        ? `${teamSize} people can administer or moderate this instance.`
        : "You're the only admin. Add moderators to share the reports queue.",
    status: teamSize > 1 ? 'done' : 'optional',
    href: '/admin/team',
  });

  return items;
}
