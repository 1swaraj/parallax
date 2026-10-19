'use client';

import {
  createPost,
  imagePost,
  mediaPath,
  textOnlyPost,
  toDataURI,
  type PostReference,
  type PostView,
} from '@lens-monad/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useBytecode } from 'wagmi';
import { createdPostId, useLensActions } from '@/lib/actions';
import { useBrand } from '@/lib/runtime-config';
import { CHAIN_ID, contracts, MAX_POST_CHARACTERS, mediaStore } from '@/lib/config';
import { prepareImage, type PreparedImage } from '@/lib/images';
import { useProfile } from '@/lib/indexer';
import { atHandle, Avatar } from './account';
import { Icon } from './icons';
import { QuotedPost } from './post';
import { useToast } from './toast';
import { Button, IconButton, ProgressBar } from './ui';

/** Characters as people count them (code points, so an emoji is one). */
export function characterCount(text: string) {
  return [...text].length;
}

/** The image's description, for screen readers. Stored on-chain with the post, like its text. */
const MAX_ALT_CHARACTERS = 420;

/**
 * Where the post's metadata says its image is, for other Lens apps: the app's public URL, or the origin it's used at.
 */
function mediaUrl(path: string) {
  return new URL(path, process.env.NEXT_PUBLIC_APP_URL || window.location.origin).toString();
}

/** The picked image, with its description and a button to remove it. */
function ImagePreview({
  image,
  alt,
  onAlt,
  onRemove,
  disabled,
}: {
  image: PreparedImage;
  alt: string;
  onAlt: (alt: string) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2">
      <div className="relative w-fit max-w-full overflow-hidden rounded-sm border border-border-default">
        {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL */}
        <img
          src={image.previewUrl}
          alt={alt || 'The image to post'}
          width={image.width}
          height={image.height}
          className="block max-h-[320px] w-auto max-w-full object-contain"
        />
        {!disabled && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove image"
            className="focus-ring absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white transition-colors duration-150 hover:bg-black/85"
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <div className="mt-2 flex rounded-sm border border-border-default bg-bg-elevated px-3 transition-colors duration-150 focus-within:border-border-focus hover:border-border-hover">
        <input
          value={alt}
          onChange={(event) => onAlt(event.target.value)}
          maxLength={MAX_ALT_CHARACTERS}
          disabled={disabled}
          placeholder="Describe the image (optional)"
          aria-label="Image description"
          autoComplete="off"
          className="w-full bg-transparent py-2 text-base text-text-primary outline-none placeholder:text-text-tertiary disabled:opacity-60 sm:text-sm"
        />
      </div>
    </div>
  );
}

/** X's character ring: fills up, turns amber in the last 20 characters, red with a count when over. */
function CharacterRing({ count }: { count: number }) {
  const remaining = MAX_POST_CHARACTERS - count;
  const progress = Math.min(1, count / MAX_POST_CHARACTERS);
  const warning = remaining <= 20;
  const size = warning ? 30 : 22;
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const color =
    remaining < 0
      ? 'var(--status-error-fg)'
      : warning
        ? 'var(--status-warning-fg)'
        : 'var(--accent-primary)';
  if (count === 0) {
    return null;
  }
  return (
    <div className="relative grid place-items-center" style={{ width: 30, height: 30 }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth="2"
        />
        {remaining > -10 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            strokeLinecap="round"
          />
        )}
      </svg>
      {warning && (
        <span
          className={`absolute font-mono text-[11px] tabular-nums ${remaining < 0 ? 'text-status-error' : 'text-text-tertiary'}`}
        >
          {remaining}
        </span>
      )}
      <span className="sr-only">{remaining} characters remaining</span>
    </div>
  );
}

export function Composer({
  replyTo,
  quoteOf,
  variant = 'inline',
  autoFocus,
  onPosted,
}: {
  replyTo?: PostView;
  quoteOf?: PostView;
  variant?: 'inline' | 'modal' | 'reply';
  autoFocus?: boolean;
  onPosted?: () => void;
}) {
  const { APP_NAME } = useBrand();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [alt, setAlt] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { run, uploadMedia, sponsored, account } = useLensActions();
  // Images only once MediaStore is on the chain: until then, uploads would pay for nothing.
  const { data: storeCode } = useBytecode({
    address: mediaStore?.address,
    chainId: CHAIN_ID,
    query: { enabled: mediaStore !== null, staleTime: Infinity },
  });
  const imagesEnabled = mediaStore !== null && !!storeCode;
  const { data: me } = useProfile(account, null);
  const toast = useToast();

  // Grow with the text, like X.
  useEffect(() => {
    const element = textarea.current;
    if (element) {
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [text]);

  const reference: PostReference = replyTo
    ? { kind: 'reply', postId: BigInt(replyTo.id) }
    : quoteOf
      ? { kind: 'quote', postId: BigInt(quoteOf.id) }
      : { kind: 'post' };

  // The preview's blob: URL lives as long as the image is picked.
  useEffect(() => {
    return () => {
      if (image) {
        URL.revokeObjectURL(image.previewUrl);
      }
    };
  }, [image]);

  const pickImage = async (file: File | undefined) => {
    if (!file || !imagesEnabled) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error('Only images can be attached');
      return;
    }
    setPreparing(true);
    try {
      setImage(await prepareImage(file));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "This image can't be used");
    } finally {
      setPreparing(false);
    }
  };

  const removeImage = () => {
    setImage(null);
    setAlt('');
  };

  // The image goes on-chain first, then the post that shows it.
  const post = useMutation({
    mutationFn: async ({ content, image }: { content: string; image: PreparedImage | null }) => {
      if (!image) {
        return run((author) =>
          createPost(contracts.LensGlobalFeed, author, toDataURI(textOnlyPost(content)), reference)
        );
      }
      const { author, id } = await uploadMedia(image.bytes, (sent, total) =>
        setUpload({ sent, total })
      );
      setUpload(null);
      const metadata = imagePost(content, {
        item: mediaUrl(mediaPath(author, id)),
        type: image.type,
        width: image.width,
        height: image.height,
        alt,
        locator: { chainId: CHAIN_ID, store: mediaStore!.address, author, id },
      });
      return run(createPost(contracts.LensGlobalFeed, author, toDataURI(metadata), reference));
    },
    onSettled: () => setUpload(null),
    onSuccess: (result) => {
      setText('');
      removeImage();
      onPosted?.();
      const id = createdPostId(result);
      toast.show(
        replyTo ? 'Your reply was sent.' : 'Your post was sent.',
        id ? { label: 'View', href: `/p/${id}` } : undefined
      );
    },
    onError: (error) => toast.error(error.message),
  });

  if (!account) {
    return null;
  }
  const count = characterCount(text);
  const canPost =
    (text.trim().length > 0 || image !== null) &&
    count <= MAX_POST_CHARACTERS &&
    !post.isPending &&
    !preparing;
  const submit = () => canPost && post.mutate({ content: text, image });
  const expanded = variant !== 'reply' || focused || text.length > 0 || image !== null;
  const placeholder = replyTo ? 'Post your reply' : quoteOf ? 'Add a comment' : "What's new?";

  return (
    <div className={variant === 'inline' ? 'border-b border-border-default' : ''}>
      {(post.isPending || preparing) && <ProgressBar />}
      <form
        className={`flex gap-3 px-4 ${variant === 'modal' ? 'pt-1 pb-3' : 'pt-3 pb-2'}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {me ? <Avatar account={me.account} size={40} /> : <div className="h-10 w-10 shrink-0" />}
        <div className="min-w-0 flex-1">
          {replyTo && variant === 'reply' && expanded && (
            <div className="pt-2 text-sm text-text-tertiary">
              Replying to <span className="text-text-accent">{atHandle(replyTo.author)}</span>
            </div>
          )}
          <div className={variant === 'reply' && !expanded ? 'flex items-center gap-3' : ''}>
            <textarea
              ref={textarea}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onFocus={() => setFocused(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              onPaste={(event) => {
                const file = [...event.clipboardData.files].find((f) =>
                  f.type.startsWith('image/')
                );
                if (file && imagesEnabled && !post.isPending) {
                  event.preventDefault();
                  void pickImage(file);
                }
              }}
              placeholder={placeholder}
              autoFocus={autoFocus}
              disabled={post.isPending}
              rows={variant === 'modal' ? 3 : 1}
              aria-label={placeholder}
              className={`block w-full flex-1 resize-none bg-transparent py-2.5 text-lg leading-7 text-text-primary outline-none placeholder:text-text-tertiary disabled:opacity-60 ${variant === 'modal' ? 'min-h-[112px]' : ''}`}
            />
            {!expanded && (
              <Button variant="primary" disabled className="shrink-0">
                Reply
              </Button>
            )}
          </div>
          {image && (
            <ImagePreview
              image={image}
              alt={alt}
              onAlt={setAlt}
              onRemove={removeImage}
              disabled={post.isPending}
            />
          )}
          {quoteOf && <QuotedPost post={quoteOf} link={false} />}
          {expanded && (
            <div
              className={`mt-2 flex items-center justify-between gap-3 py-2 ${variant === 'inline' && (focused || text) ? 'border-t border-border-default' : ''} ${variant === 'modal' ? 'border-t border-border-default' : ''}`}
            >
              <div className="flex items-center gap-3">
                {imagesEnabled && (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(event) => {
                        void pickImage(event.target.files?.[0]);
                        event.target.value = '';
                      }}
                    />
                    <IconButton
                      icon="image"
                      label="Add an image"
                      onClick={() => fileInput.current?.click()}
                      disabled={post.isPending || preparing || image !== null}
                      className="-ml-2"
                    />
                  </>
                )}
                <span
                  className="mono-caps flex items-center gap-1.5 text-[11px] leading-4 text-text-tertiary"
                  title={
                    sponsored
                      ? `${APP_NAME} pays this post's network fee`
                      : image
                        ? "Your wallet pays this post's network fees, in MON: one transaction per 64 KB of image, then the post"
                        : "Your wallet pays this post's network fee, in MON"
                  }
                >
                  <Icon name="gas" size={14} />
                  {sponsored ? 'No fee' : 'Fee in MON'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {upload && (
                  <span className="text-xs text-text-tertiary tabular-nums" aria-live="polite">
                    Uploading image {Math.min(upload.sent + 1, upload.total)}/{upload.total}
                  </span>
                )}
                <CharacterRing count={count} />
                {count > 0 && <span className="h-6 w-px bg-border-default" />}
                <Button type="submit" variant="primary" disabled={!canPost}>
                  {replyTo ? 'Reply' : 'Post'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
