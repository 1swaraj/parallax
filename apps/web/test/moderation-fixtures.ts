import type { AccountView, PostView } from '@lens-monad/protocol';
import type { ModeratedAccount } from '../src/lib/moderation-policy';
export const owner = '0x0000000000000000000000000000000000000001';
export const account = '0x0000000000000000000000000000000000000002';
export const other = '0x0000000000000000000000000000000000000003';
export function accountView(address = account): AccountView {
  return {
    address: address as `0x${string}`,
    owner,
    username: 'alice',
    name: 'Alice',
    bio: null,
    picture: null,
    sponsored: true,
    followers: 0,
    following: 0,
    posts: 0,
    createdAt: '1',
  };
}
export function postView(id = '1', author = account, content = 'hello'): PostView {
  return {
    id,
    author: accountView(author),
    content,
    contentUri: 'data:private',
    image: null,
    rootPostId: id,
    repliedPostId: null,
    quotedPostId: null,
    repostedPostId: null,
    replies: 0,
    reposts: 0,
    quotes: 0,
    deleted: false,
    createdAt: String(Math.floor(Date.now() / 1000)),
    editedAt: null,
    quoted: null,
    reposted: null,
    repliedTo: null,
    viewerRepostId: null,
  };
}
export function status(patch: Partial<ModeratedAccount> = {}): ModeratedAccount {
  return {
    account,
    owner,
    member: false,
    approved: false,
    hidden: false,
    suspended: false,
    sponsorRevoked: false,
    label: null,
    createdAt: 1,
    reason: '',
    ...patch,
  };
}
