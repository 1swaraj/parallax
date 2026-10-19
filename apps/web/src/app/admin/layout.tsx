import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findAdmin } from '@/lib/server/admin';
import { PageHeader } from '@/components/ui';
export const dynamic = 'force-dynamic';
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await findAdmin();
  if (!admin) notFound();
  const links = [
    ['', 'Overview'],
    ...(admin.role !== 'moderator'
      ? [
          ['branding', 'Branding'],
          ['network', 'Network'],
          ['sponsorship', 'Sponsorship & limits'],
          ['email', 'Email'],
        ]
      : []),
    ...(admin.role === 'owner' ? [['team', 'Team']] : []),
    ['moderation', 'Moderation'],
    ...(admin.role !== 'moderator' ? [['audit', 'Audit log']] : []),
  ];
  return (
    <>
      <PageHeader title="Instance admin" meta={admin.role} />
      <nav
        aria-label="Admin"
        className="flex flex-wrap gap-x-5 gap-y-3 border-b border-border-default p-4 font-mono text-xs uppercase"
      >
        {links.map(([href, label]) => (
          <Link
            key={href}
            href={`/admin${href ? `/${href}` : ''}`}
            className="focus-ring hover:text-accent-primary"
          >
            {label}
          </Link>
        ))}
        <Link href="/">Back to app</Link>
      </nav>
      {children}
    </>
  );
}
