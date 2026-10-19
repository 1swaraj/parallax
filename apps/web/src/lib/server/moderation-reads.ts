import type { AccountView, NotificationView, PostView, ThreadView } from '@lens-monad/protocol';
import {
  contentDecision,
  type ModerationPolicy,
  type ModerationSnapshot,
} from '../moderation-policy';

export function hiddenAccount(account: AccountView, state: ModerationSnapshot) {
  const status = state.accounts.get(account.address.toLowerCase());
  const wallet = account.owner ? state.accounts.get(account.owner.toLowerCase()) : undefined;
  return !!(status?.hidden || status?.suspended || wallet?.hidden || wallet?.suspended);
}
export function hiddenPost(post: PostView, state: ModerationSnapshot): boolean {
  return (
    hiddenAccount(post.author, state) ||
    state.posts.get(post.id)?.action === 'hide' ||
    contentDecision(state.filters, post.content ?? '').hidden ||
    (!!post.reposted && hiddenPost(post.reposted, state))
  );
}
function placeholder(post: PostView): PostView {
  return {
    ...post,
    content: null,
    contentUri: '',
    image: null,
    deleted: true,
    quoted: null,
    reposted: null,
    repliedTo: null,
    author: { ...post.author, name: null, bio: null, picture: null, username: null },
    replies: 0,
    reposts: 0,
    quotes: 0,
    moderation: { hidden: true, warning: null },
  };
}
export function moderatePost(post: PostView, state: ModerationSnapshot): PostView {
  if (hiddenPost(post, state)) return placeholder(post);
  const specific = state.posts.get(post.id);
  const warning =
    specific?.action === 'label'
      ? specific.reason
      : (state.accounts.get(post.author.address.toLowerCase())?.label ??
        contentDecision(state.filters, post.content ?? '').label);
  return {
    ...post,
    moderation: { hidden: false, warning },
    quoted: post.quoted ? moderatePost(post.quoted, state) : null,
    reposted: post.reposted ? moderatePost(post.reposted, state) : null,
    repliedTo:
      post.repliedTo && hiddenAccount(post.repliedTo.author, state) ? null : post.repliedTo,
  };
}
export function moderateThread(thread: ThreadView, state: ModerationSnapshot): ThreadView {
  return {
    post: moderatePost(thread.post, state),
    ancestors: thread.ancestors.map((p) => moderatePost(p, state)),
    replies: thread.replies.filter((p) => !hiddenPost(p, state)).map((p) => moderatePost(p, state)),
  };
}
export function homeAllowed(post: PostView, policy: ModerationPolicy, state: ModerationSnapshot) {
  const author = post.author.address.toLowerCase();
  return (
    policy.homeFeed === 'network' ||
    (policy.homeFeed === 'members' && !!state.accounts.get(author)?.member) ||
    (policy.homeFeed === 'curated' &&
      policy.curatedAccounts.some((a) => a.toLowerCase() === author))
  );
}
export function visibleNotification(item: NotificationView, state: ModerationSnapshot) {
  return !hiddenAccount(item.actor, state) && (!item.post || !hiddenPost(item.post, state));
}

/** Fetch only the remaining capacity. Each upstream cursor covers exactly the items consumed,
 * including hidden items; a full response never discards unconsumed visible items. Bounded work may
 * return a partial (even empty) page with a continuation, rather than falsely claiming exhaustion. */
export async function filteredPage<T>(
  load: (cursor: string | null, limit: number) => Promise<{ items: T[]; next: string | null }>,
  transform: (item: T) => T | null,
  limit: number,
  cursor: string | null,
  maxPages = 10
) {
  const items: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxPages; i++) {
    const page = await load(cursor, limit - items.length);
    for (const item of page.items) {
      const visible = transform(item);
      if (visible) items.push(visible);
    }
    const next = page.next;
    if (next && (next === cursor || seen.has(next)))
      throw new Error('Indexer returned a repeated cursor');
    cursor = next;
    if (cursor) seen.add(cursor);
    if (!cursor || items.length >= limit) break;
  }
  return { items, next: cursor };
}
