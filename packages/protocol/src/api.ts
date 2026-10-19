/**
 * Responses of the indexer's REST API (apps/indexer/src/api). Big numbers (post ids, timestamps) are strings, and
 * addresses are checksummed. Endpoints that take `viewer` (a Lens Account address) add what concerns the viewer.
 *
 *   GET /timeline?viewer&cursor&limit                     Page<PostView>    posts, quotes, reposts (no replies)
 *   GET /timeline/following?viewer&cursor&limit           Page<PostView>    same, from the viewer and who they follow
 *   GET /posts?ids=1,2&viewer                              { items: PostView[] } in the order asked, missing ones left out
 *   GET /posts/:id?viewer                                  ThreadView
 *   GET /accounts?q&owner&limit                            Page<AccountView> username prefix search, or by owner EOA
 *   GET /accounts/suggested?viewer&limit                   Page<AccountView> most followed, minus the viewer and who they follow
 *   GET /accounts/:handle?viewer                           ProfileView       handle: username or address
 *   GET /accounts/:handle/posts?replies&viewer&cursor      Page<PostView>
 *   GET /accounts/:handle/followers?cursor&limit           Page<AccountView>
 *   GET /accounts/:handle/following?cursor&limit           Page<AccountView>
 *   GET /relationships?viewer&accounts=0xa,0xb             Record<address, Relationship>
 *   GET /search/posts?q&viewer&cursor&limit                Page<PostView>    content contains q, or has the hashtag q (#tag)
 *   GET /trends?limit=5&hours=24                           { items: TrendView[] } hashtags of the most posts in the window
 *   GET /notifications?account&type=all|mentions&cursor   Page<NotificationView>
 *   GET /notifications/unread?account&since                { count: number } notifications newer than the `since` cursor
 *   GET /media/:author/:id                                 the image's bytes, once all its chunks are in and match its id
 *   GET /status                                            Ponder: { [chain]: { id, block: { number, timestamp } } }
 */

export type AccountView = {
  address: `0x${string}`;
  owner: `0x${string}`;
  username: string | null;
  name: string | null;
  bio: string | null;
  picture: string | null;
  /** Whether relayers can act for the Account through SponsorRouter. */
  sponsored: boolean;
  followers: number;
  following: number;
  posts: number;
  createdAt: string;
};

/** How the viewer relates to an Account. */
export type Relationship = {
  following: boolean;
  followedBy: boolean;
  blocking: boolean;
  blockedBy: boolean;
};

/**
 * A post's image. `url` is the app's /media path for images in this chain's MediaStore, or the metadata's https URL
 * for images hosted elsewhere. Width and height are the metadata's, when it gives them.
 */
export type ImageView = {
  url: string;
  type: string;
  alt: string | null;
  width: number | null;
  height: number | null;
};

export type PostView = {
  /** Added by an instance's server read layer, never by the shared indexer. */
  moderation?: { hidden: boolean; warning: string | null };
  id: string;
  author: AccountView;
  content: string | null;
  /** Null for posts without an image, and for deleted posts. */
  image: ImageView | null;
  contentUri: string;
  rootPostId: string;
  repliedPostId: string | null;
  quotedPostId: string | null;
  repostedPostId: string | null;
  replies: number;
  reposts: number;
  quotes: number;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  /** The quoted or reposted post, one level deep. */
  quoted: PostView | null;
  reposted: PostView | null;
  /** Who the post replies to. */
  repliedTo: { id: string; author: AccountView } | null;
  /**
   * When the request has a `viewer`: the id of the viewer's live repost of this post (for reposts, of the reposted
   * post), so the client can show it as reposted and undo it by deleting that repost. Null otherwise.
   */
  viewerRepostId: string | null;
};

export type Page<T> = { items: T[]; next: string | null };

export type ProfileView = { account: AccountView; relationship: Relationship | null };

/** A post, the posts it replies to (root first, at most 10), and its direct replies (oldest first). */
export type ThreadView = { post: PostView; ancestors: PostView[]; replies: PostView[] };

export type NotificationType = 'follow' | 'reply' | 'repost' | 'quote' | 'mention';

export type NotificationView = {
  /** Unique, and the position to pass as `since` / `cursor`: `<blockNumber>:<logIndex>`. */
  id: string;
  type: NotificationType;
  actor: AccountView;
  /**
   * reply, quote, mention: the actor's post. repost: the recipient's post that was reposted. follow: null. Null too
   * when the post was deleted since (the notification is then omitted).
   */
  post: PostView | null;
  createdAt: string;
};

/** A hashtag (lowercase, without '#'), and how many live posts have it in the window. */
export type TrendView = { tag: string; posts: number };

export type SyncStatus = { block: string };
