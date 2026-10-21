'use client';

import {
  blockAccount,
  deletePost,
  repost,
  type ImageView,
  type MediaLinkView,
  type PostView,
} from '@lens-monad/protocol';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { isAddressEqual } from 'viem';
import { useLensActions } from '@/lib/actions';
import { useSession } from '@/lib/session';
import { useLike, useToggleLike } from '@/lib/likes';
import { contracts, MIRROR } from '@/lib/config';
import {
  atHandle,
  Avatar,
  compactNumber,
  displayName,
  FullTime,
  NameLine,
  profileHref,
  RelativeTime,
  RichText,
} from './account';
import { Icon, type IconName } from './icons';
import { useAuthModal, useCompose, useConfirm } from './modals';
import { useToast } from './toast';
import { CornerBrackets, Dropdown } from './ui';
import { ContentWarning, useReport } from './moderation';

/** One action of the bar: icon and mono count. Purple on hover and when active, like every interaction. */
function ActionButton({
  icon,
  label,
  count,
  active = false,
  large = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  count?: number;
  active?: boolean;
  large?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={count ? `${label}, ${count}` : label}
      aria-pressed={active || undefined}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className={`group focus-ring -my-1.5 -ml-2 flex items-center gap-1 rounded-sm py-1.5 pr-2 pl-2 transition-colors duration-150 hover:bg-bg-hover hover:text-text-accent ${active ? 'text-text-accent' : 'text-text-tertiary'}`}
    >
      <Icon name={icon} size={large ? 22 : 18} strokeWidth={active ? 2 : 1.5} filled={active} />
      {count !== undefined && (
        <span className="min-w-[3ch] text-left font-mono text-xs tabular-nums">
          {count > 0 ? compactNumber(count) : ''}
        </span>
      )}
    </button>
  );
}

/**
 * A post's image, at its own aspect ratio (from its metadata, so the feed doesn't jump as images load), opening at
 * full size. Inside a quoted post, which is a link itself, it's smaller and not a link.
 */
export function PostImage({ image, compact = false }: { image: ImageView; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="mt-3 rounded-sm bg-bg-subtle px-4 py-3 text-sm text-text-tertiary">
        This image is unavailable.
      </div>
    );
  }
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- served by the indexer, or hosted by another Lens app
    <img
      src={image.url}
      alt={image.alt ?? 'Image'}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`block h-auto w-auto max-w-full bg-bg-subtle object-contain ${compact ? 'max-h-[240px]' : 'max-h-[510px]'}`}
    />
  );
  const frame =
    'mt-3 block w-fit max-w-full overflow-hidden rounded-sm border border-border-default';
  if (compact) {
    return <div className={frame}>{img}</div>;
  }
  return (
    <a
      href={image.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className={`focus-ring ${frame}`}
    >
      {img}
    </a>
  );
}

const MEDIA_LABELS: Record<MediaLinkView['kind'], string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  file: 'File',
  link: 'Link',
  metadata: 'Post metadata',
};

/**
 * What a post links to rather than shows (from Lens Chain: video, audio, files, links), or the post's metadata itself
 * when the indexer couldn't read it. It opens where it's hosted. Inside a quoted post, which is a link, it's a label.
 */
export function MediaLink({ media, link = true }: { media: MediaLinkView; link?: boolean }) {
  let host = media.url;
  try {
    host = new URL(media.url).hostname;
  } catch {}
  const body = (
    <>
      <Icon
        name={
          media.kind === 'video' || media.kind === 'audio'
            ? 'play'
            : media.kind === 'image'
              ? 'image'
              : 'link'
        }
        size={16}
        className="shrink-0 text-text-accent"
      />
      <span className="font-medium text-text-primary">{MEDIA_LABELS[media.kind]}</span>
      <span className="truncate text-text-tertiary">{host}</span>
    </>
  );
  const frame =
    'mt-3 flex w-fit max-w-full items-center gap-2 rounded-sm border border-border-default bg-bg-elevated px-3 py-2 text-sm';
  return link ? (
    <a
      href={media.url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      onClick={(event) => event.stopPropagation()}
      className={`focus-ring ${frame} transition-colors duration-150 hover:border-border-strong`}
    >
      {body}
    </a>
  ) : (
    <span className={frame}>{body}</span>
  );
}

/** Content that isn't there to show: offchain, and not read (or unreadable). */
function isOffchainOnly(post: PostView) {
  return post.content === null && !post.image && (!post.media || post.media.kind === 'metadata');
}

/** The quoted post inside a post. Its text is plain because the card is itself a link; links can't nest. */
export function QuotedPost({ post, link = true }: { post: PostView; link?: boolean }) {
  if (post.deleted) {
    return (
      <div className="mt-3 rounded-sm bg-bg-subtle px-4 py-3 text-sm text-text-tertiary">
        {post.moderation?.hidden ? 'Hidden by moderators' : 'This post is unavailable.'}
      </div>
    );
  }
  const body = (
    <ContentWarning warning={post.moderation?.warning}>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Avatar account={post.author} size={20} />
        <NameLine account={post.author} link={false} />
        <span className="text-text-tertiary">·</span>
        <RelativeTime seconds={post.createdAt} />
      </div>
      {post.content && (
        <p className="mt-1.5 line-clamp-6 text-sm break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-text-primary">
          {post.content}
        </p>
      )}
      {post.image && <PostImage image={post.image} compact />}
      {post.media && post.media.kind !== 'metadata' && (
        <MediaLink media={post.media} link={false} />
      )}
    </ContentWarning>
  );
  const frame = 'mt-3 block rounded-sm border border-border-default bg-bg-elevated px-3 py-3';
  if (!link) {
    return <div className={frame}>{body}</div>;
  }
  return (
    <Link
      href={`/p/${post.id}`}
      onClick={(event) => event.stopPropagation()}
      className={`focus-ring ${frame} transition-colors duration-150 hover:border-border-strong`}
    >
      {body}
    </Link>
  );
}

function useCopyLink() {
  const toast = useToast();
  return (id: string) => {
    const url = `${window.location.origin}/p/${id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.show('Link copied'))
      .catch(() => toast.error("Couldn't copy the link"));
  };
}

/** The heart. Likes are Parallax's own (Lens has no onchain likes), so they're instant and free. */
function LikeButton({ postId, large }: { postId: string; large: boolean }) {
  const { account } = useSession();
  const openAuth = useAuthModal();
  const toast = useToast();
  const { data } = useLike(postId);
  const toggle = useToggleLike(postId);
  const liked = data?.liked ?? false;
  return (
    <ActionButton
      icon="heart"
      label={liked ? 'Unlike' : 'Like'}
      count={large ? undefined : (data?.count ?? 0)}
      active={liked}
      large={large}
      onClick={() =>
        !account
          ? openAuth()
          : !toggle.isPending &&
            toggle.mutate(!liked, { onError: (error) => toast.error(error.message) })
      }
    />
  );
}

/** Reply, repost (or quote), like, copy link, with the repost's optimistic state. */
function PostActions({ post, large = false }: { post: PostView; large?: boolean }) {
  const { run, account } = useLensActions();
  const openAuth = useAuthModal();
  const compose = useCompose();
  const toast = useToast();
  const copyLink = useCopyLink();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const reposted = optimistic ?? post.viewerRepostId !== null;
  const reposts = post.reposts + (optimistic === null ? 0 : optimistic ? 1 : -1);

  const toggleRepost = useMutation({
    mutationFn: (next: boolean) =>
      run((author) =>
        next
          ? repost(contracts.LensGlobalFeed, author, BigInt(post.id))
          : deletePost(contracts.LensGlobalFeed, BigInt(post.viewerRepostId!))
      ),
    onMutate: (next) => setOptimistic(next),
    onSettled: () => setOptimistic(null),
    onError: (error) => toast.error(error.message),
  });

  const requireAccount = (action: () => void) => () => (account ? action() : openAuth());

  return (
    <div
      className={`flex items-center justify-between ${large ? 'h-12 px-2' : 'h-8 max-w-[420px]'}`}
    >
      <ActionButton
        icon="reply"
        label="Reply"
        count={large ? undefined : post.replies}
        large={large}
        onClick={requireAccount(() => compose({ replyTo: post }))}
      />
      <Dropdown
        align="left"
        items={[
          {
            label: reposted ? 'Undo repost' : 'Repost',
            icon: 'repost',
            hidden: reposted && !post.viewerRepostId,
            onSelect: requireAccount(() => toggleRepost.mutate(!reposted)),
          },
          {
            label: 'Quote',
            icon: 'quote',
            onSelect: requireAccount(() => compose({ quoteOf: post })),
          },
        ]}
        trigger={({ toggle }) => (
          <ActionButton
            icon="repost"
            label={reposted ? 'Undo repost' : 'Repost'}
            count={large ? undefined : reposts}
            active={reposted}
            large={large}
            onClick={toggleRepost.isPending ? undefined : toggle}
          />
        )}
      />
      <LikeButton postId={post.id} large={large} />
      <ActionButton
        icon="share"
        label="Copy link"
        large={large}
        onClick={() => copyLink(post.id)}
      />
    </div>
  );
}

/** A count of the action bar, in mirror mode: what happened on Lens Chain, which can't be added to here. */
function Count({ icon, label, count }: { icon: IconName; label: string; count: number }) {
  return (
    <span
      aria-label={`${count} ${label}`}
      title={label}
      className="-my-1.5 -ml-2 flex items-center gap-1 py-1.5 pr-2 pl-2 text-text-tertiary"
    >
      <Icon name={icon} size={18} strokeWidth={1.5} />
      <span className="min-w-[3ch] text-left font-mono text-xs tabular-nums">
        {count > 0 ? compactNumber(count) : ''}
      </span>
    </span>
  );
}

/**
 * The action bar of a mirror's client, which writes nothing: replies, reposts and quotes as counts, and the link to
 * copy. A thread's post shows its counts above, so it keeps the link only.
 */
function ReadOnlyActions({ post, large = false }: { post: PostView; large?: boolean }) {
  const copyLink = useCopyLink();
  return (
    <div
      className={`flex items-center justify-between ${large ? 'h-12 px-2' : 'h-8 max-w-[420px]'}`}
    >
      {!large && (
        <>
          <Count
            icon="reply"
            label={post.replies === 1 ? 'reply' : 'replies'}
            count={post.replies}
          />
          <Count
            icon="repost"
            label={post.reposts === 1 ? 'repost' : 'reposts'}
            count={post.reposts}
          />
          <Count icon="quote" label={post.quotes === 1 ? 'quote' : 'quotes'} count={post.quotes} />
        </>
      )}
      <ActionButton
        icon="share"
        label="Copy link"
        large={large}
        onClick={() => copyLink(post.id)}
      />
    </div>
  );
}

/** The "…" menu: delete your own post, block others, copy the link. */
function PostMenu({ post, linkId }: { post: PostView; linkId: string }) {
  const { openReport, dialog } = useReport('post', post.id);
  const { run, account } = useLensActions();
  const toast = useToast();
  const confirm = useConfirm();
  const copyLink = useCopyLink();
  const isOwn = !!account && isAddressEqual(account, post.author.address);

  const remove = useMutation({
    mutationFn: () => run(deletePost(contracts.LensGlobalFeed, BigInt(post.id))),
    onSuccess: () => toast.show('Your post was deleted'),
    onError: (error) => toast.error(error.message),
  });
  const block = useMutation({
    mutationFn: () =>
      run((viewer) => blockAccount(contracts.AccountBlockingRule, viewer, post.author.address)),
    onSuccess: () => toast.show(`You blocked ${atHandle(post.author)}`),
    onError: (error) => toast.error(error.message),
  });

  return (
    <>
      {dialog}
      <Dropdown
        items={[
          {
            label: 'Delete post',
            icon: 'trash',
            danger: true,
            hidden: !isOwn || MIRROR,
            onSelect: () =>
              confirm({
                title: 'Delete post?',
                body: 'It disappears from your profile, timelines and search. Like everything on Lens, the original stays readable onchain.',
                action: 'Delete',
                danger: true,
                onConfirm: () => remove.mutate(),
              }),
          },
          {
            label: `Block ${atHandle(post.author)}`,
            icon: 'block',
            danger: true,
            hidden: !account || isOwn || MIRROR,
            onSelect: () =>
              confirm({
                title: `Block ${atHandle(post.author)}?`,
                body: "They won't be able to follow you or reply to you, and their posts leave your timelines.",
                action: 'Block',
                danger: true,
                onConfirm: () => block.mutate(),
              }),
          },
          { label: 'Copy link', icon: 'link', onSelect: () => copyLink(linkId) },
          { label: 'Report post', icon: 'block', onSelect: openReport },
        ]}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            aria-label="More"
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
            className="focus-ring -my-1.5 -mr-2 grid h-8 w-8 place-items-center rounded-sm text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
          >
            <Icon name="more" size={18} />
          </button>
        )}
      />
    </>
  );
}

/**
 * A post in a list (hover fill and corner brackets). Reposts show the reposted post under
 * "X reposted". In a thread, `lineAbove` / `lineBelow` draw the line that links the avatars.
 */
export function PostCard({
  post,
  lineAbove = false,
  lineBelow = false,
}: {
  post: PostView;
  lineAbove?: boolean;
  lineBelow?: boolean;
}) {
  const router = useRouter();
  const { account } = useSession();
  const shown = post.reposted ?? post;
  const isOwnRepost = !!post.reposted && !!account && isAddressEqual(account, post.author.address);

  if (shown.deleted) {
    return (
      <div className="border-b border-border-default px-4 py-3">
        <div className="rounded-sm bg-bg-subtle px-4 py-3 text-sm text-text-tertiary">
          {shown.moderation?.hidden ? 'Hidden by moderators' : 'This post is unavailable.'}
        </div>
      </div>
    );
  }

  const open = (event: React.MouseEvent) => {
    if (window.getSelection()?.toString()) {
      return; // Selecting text isn't a click.
    }
    if (event.metaKey || event.ctrlKey) {
      window.open(`/p/${shown.id}`, '_blank', 'noopener');
    } else {
      router.push(`/p/${shown.id}`);
    }
  };

  return (
    <article
      onClick={open}
      aria-label={`Post by ${displayName(shown.author)}`}
      className={`group/post relative cursor-pointer px-4 transition-colors duration-150 hover:bg-bg-hover ${lineBelow ? '' : 'border-b border-border-default'}`}
    >
      <span className="hidden group-hover/post:contents">
        <CornerBrackets size={8} />
      </span>
      {post.reposted ? (
        <div className="flex gap-3 pt-3 text-xs font-semibold text-text-tertiary">
          <div className="flex w-10 justify-end">
            <Icon name="repost" size={14} />
          </div>
          <Link
            href={profileHref(post.author)}
            onClick={(event) => event.stopPropagation()}
            className="-mb-1.5 truncate hover:underline"
          >
            {isOwnRepost ? 'You' : displayName(post.author)} reposted
          </Link>
        </div>
      ) : (
        <div className="flex h-3 gap-3">
          <div className="flex w-10 justify-center">
            {lineAbove && <div className="w-0.5 bg-border-strong" />}
          </div>
        </div>
      )}
      <div className="flex gap-3">
        <div className="flex w-10 shrink-0 flex-col items-center">
          <Link
            href={profileHref(shown.author)}
            onClick={(event) => event.stopPropagation()}
            className="group/avatar focus-ring rounded-full"
          >
            <Avatar account={shown.author} size={40} hover />
          </Link>
          {lineBelow && <div className="mt-1 w-0.5 flex-1 bg-border-strong" />}
        </div>
        <div className="min-w-0 flex-1 pb-3">
          <div className="flex items-start gap-1">
            <div className="flex min-w-0 flex-1 items-baseline gap-1 text-sm">
              <NameLine account={shown.author} className="shrink" />
              <span className="text-text-tertiary">·</span>
              <Link
                href={`/p/${shown.id}`}
                onClick={(event) => event.stopPropagation()}
                className="shrink-0"
              >
                <RelativeTime seconds={shown.createdAt} />
              </Link>
            </div>
            <PostMenu post={shown} linkId={shown.id} />
          </div>
          {shown.repliedTo && !lineAbove && (
            <div className="text-sm text-text-tertiary">
              Replying to{' '}
              <Link
                href={profileHref(shown.repliedTo.author)}
                onClick={(event) => event.stopPropagation()}
                className="text-text-accent hover:underline"
              >
                {atHandle(shown.repliedTo.author)}
              </Link>
            </div>
          )}
          <ContentWarning warning={shown.moderation?.warning}>
            {shown.content !== null ? (
              <RichText
                text={shown.content}
                // Lens Chain's posts run to 25,000 characters: the thread shows them whole.
                className={`mt-1 text-base leading-6 text-text-primary ${MIRROR ? 'line-clamp-12' : ''}`}
              />
            ) : (
              isOffchainOnly(shown) && (
                <p className="mt-1 text-sm text-text-tertiary italic">
                  This post's content is stored offchain.
                </p>
              )
            )}
            {shown.image && <PostImage image={shown.image} />}
            {shown.media && <MediaLink media={shown.media} />}
            {shown.quoted && <QuotedPost post={shown.quoted} />}
          </ContentWarning>
          <div className="mt-3">
            {MIRROR ? <ReadOnlyActions post={shown} /> : <PostActions post={shown} />}
          </div>
        </div>
      </div>
    </article>
  );
}

/** The post a thread page is about: larger text, the full date, counts, then its actions. */
export function FocusPost({ post, lineAbove }: { post: PostView; lineAbove: boolean }) {
  const { data: likes } = useLike(post.id);
  return (
    <article className="border-b border-border-default px-4">
      <div className="flex h-3 gap-3">
        <div className="flex w-10 justify-center">
          {lineAbove && <div className="w-0.5 bg-border-strong" />}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Link href={profileHref(post.author)} className="group/avatar focus-ring rounded-full">
          <Avatar account={post.author} size={40} hover />
        </Link>
        <div className="min-w-0 flex-1 text-sm">
          <Link
            href={profileHref(post.author)}
            className="block truncate font-semibold text-text-primary hover:underline"
          >
            {displayName(post.author)}
          </Link>
          <div className="truncate text-text-tertiary">{atHandle(post.author)}</div>
        </div>
        <PostMenu post={post} linkId={post.id} />
      </div>
      <ContentWarning warning={post.moderation?.warning}>
        {post.content !== null ? (
          <RichText text={post.content} className="mt-3 text-lg leading-7 text-text-primary" />
        ) : (
          isOffchainOnly(post) && (
            <p className="mt-3 text-text-tertiary italic">
              This post's content is stored offchain.
            </p>
          )
        )}
        {post.image && <PostImage image={post.image} />}
        {post.media && <MediaLink media={post.media} />}
        {post.quoted && <QuotedPost post={post.quoted} />}
      </ContentWarning>
      <div className="py-4">
        <FullTime seconds={post.createdAt} />
        {post.editedAt && <span className="mono-caps text-xs text-text-tertiary"> · Edited</span>}
      </div>
      {(post.reposts > 0 || post.quotes > 0 || post.replies > 0 || !!likes?.count) && (
        <div className="flex gap-6 border-t border-border-default py-3 text-sm">
          {(
            [
              [post.replies, post.replies === 1 ? 'Reply' : 'Replies'],
              [post.reposts, post.reposts === 1 ? 'Repost' : 'Reposts'],
              [post.quotes, post.quotes === 1 ? 'Quote' : 'Quotes'],
              [likes?.count ?? 0, likes?.count === 1 ? 'Like' : 'Likes'],
            ] as const
          )
            .filter(([count]) => count > 0)
            .map(([count, label]) => (
              <span key={label}>
                <span className="font-mono font-medium text-text-primary tabular-nums">
                  {compactNumber(count)}
                </span>{' '}
                <span className="text-text-tertiary">{label}</span>
              </span>
            ))}
        </div>
      )}
      <div className="border-t border-border-default">
        {MIRROR ? <ReadOnlyActions post={post} large /> : <PostActions post={post} large />}
      </div>
    </article>
  );
}
