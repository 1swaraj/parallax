import type { Metadata } from 'next';
import { ThreadPage } from '@/components/thread';
import { postMetadata } from '@/lib/seo';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return postMetadata((await params).id);
}

export default async function Page({ params }: Props) {
  return <ThreadPage id={(await params).id} />;
}
