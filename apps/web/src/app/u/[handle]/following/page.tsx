import type { Metadata } from 'next';
import { FollowListPage } from '@/components/profile';
import { profileMetadata } from '@/lib/seo';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return profileMetadata(decodeURIComponent((await params).handle));
}

export default async function Page({ params }: Props) {
  return (
    <FollowListPage handle={decodeURIComponent((await params).handle)} direction="following" />
  );
}
