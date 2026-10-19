import type { ProfileView, ThreadView } from '@lens-monad/protocol';
import type { Metadata } from 'next';
import { getInstanceConfig } from './server/instance-config';
import { moderationSnapshot } from './server/moderation';
import { hiddenAccount, hiddenPost, moderatePost } from './server/moderation-reads';

/** Server-side reads for link previews. Failures just mean a generic preview. */
async function fetchIndexer<T>(path: string): Promise<T | null> {
  try {
    const { indexerUrl } = await getInstanceConfig();
    const response = await fetch(`${indexerUrl}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

function excerpt(text: string, length = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

export async function profileMetadata(handle: string): Promise<Metadata> {
  const { appName: APP_NAME } = await getInstanceConfig();
  const profile = await fetchIndexer<ProfileView>(`/accounts/${encodeURIComponent(handle)}`);
  if (!profile || hiddenAccount(profile.account, await moderationSnapshot())) {
    return { title: 'Profile' };
  }
  const { account } = profile;
  const name = account.name || account.username || account.address;
  const title = account.username ? `${name} (@${account.username})` : name;
  const description = account.bio
    ? excerpt(account.bio)
    : `${title} on ${APP_NAME}, a Lens app on Monad.`;
  return {
    title,
    description,
    openGraph: { title, description, type: 'profile' },
    twitter: { title, description },
  };
}

export async function postMetadata(id: string): Promise<Metadata> {
  const { appName: APP_NAME } = await getInstanceConfig();
  const thread = await fetchIndexer<ThreadView>(`/posts/${encodeURIComponent(id)}`);
  if (
    !thread ||
    thread.post.deleted ||
    hiddenPost(thread.post, await moderationSnapshot()) ||
    moderatePost(thread.post, await moderationSnapshot()).moderation?.warning
  ) {
    return { title: 'Post' };
  }
  const { post } = thread;
  const name = post.author.name || post.author.username || post.author.address;
  const title = `${name} on ${APP_NAME}`;
  const description = post.content ? excerpt(post.content) : `A post by ${name}.`;
  return {
    title: post.content ? `${name}: "${excerpt(post.content, 60)}"` : title,
    description,
    openGraph: { title, description, type: 'article' },
    twitter: { title, description },
  };
}
