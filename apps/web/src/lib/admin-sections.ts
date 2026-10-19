export type AdminRole = 'owner' | 'admin' | 'moderator';

export type AdminSection = {
  slug: string;
  label: string;
  description: string;
  roles: readonly AdminRole[];
};

const CONFIG: readonly AdminRole[] = ['owner', 'admin'];
const EVERYONE: readonly AdminRole[] = ['owner', 'admin', 'moderator'];

/** The admin panel's pages, in nav order. Each page checks the role again on the server. */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    slug: 'branding',
    label: 'Branding',
    description: 'Name, tagline, logo, icon, accent colors and the default appearance.',
    roles: CONFIG,
  },
  {
    slug: 'network',
    label: 'Network',
    description: "Public app URL, RPCs, explorer, indexer and this instance's SponsorRouter.",
    roles: CONFIG,
  },
  {
    slug: 'sponsorship',
    label: 'Sponsorship & limits',
    description: 'Pause, the hourly gas budget, relayer keys and rate limits.',
    roles: CONFIG,
  },
  {
    slug: 'email',
    label: 'Email',
    description: 'Resend key and domain, test emails, operator alerts and user digests.',
    roles: CONFIG,
  },
  {
    slug: 'team',
    label: 'Team',
    description: 'Add or remove admins and moderators, by address or username.',
    roles: ['owner'],
  },
  {
    slug: 'moderation',
    label: 'Moderation',
    description: 'Reports queue, who can sign up, who is sponsored, filters and invites.',
    roles: EVERYONE,
  },
  {
    slug: 'moderation-log',
    label: 'Moderation log',
    description: "Every moderator action, and each account's history.",
    roles: EVERYONE,
  },
  {
    slug: 'audit',
    label: 'Audit log',
    description: 'Every change to settings, secrets and the team.',
    roles: CONFIG,
  },
];

export function sectionsFor(role: AdminRole): AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => section.roles.includes(role));
}
