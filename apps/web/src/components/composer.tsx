'use client';

import {
  createPost,
  textOnlyPost,
  toDataURI,
  type PostReference,
  type PostView,
} from '@lens-monad/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createdPostId, useLensActions } from '@/lib/actions';
import { contracts, MAX_POST_CHARACTERS } from '@/lib/config';
import { useProfile } from '@/lib/indexer';
import { atHandle, Avatar } from './account';
import { Icon } from './icons';
import { QuotedPost } from './post';
import { useToast } from './toast';
import { Button, ProgressBar } from './ui';

/** Characters as people count them (code points, so an emoji is one). */
export function characterCount(text: string) {
  return [...text].length;
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
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { run, sponsored, account } = useLensActions();
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

  const post = useMutation({
    mutationFn: (content: string) =>
      run((author) =>
        createPost(contracts.LensGlobalFeed, author, toDataURI(textOnlyPost(content)), reference)
      ),
    onSuccess: (result) => {
      setText('');
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
  const canPost = text.trim().length > 0 && count <= MAX_POST_CHARACTERS && !post.isPending;
  const submit = () => canPost && post.mutate(text);
  const expanded = variant !== 'reply' || focused || text.length > 0;
  const placeholder = replyTo
    ? 'Post your reply'
    : quoteOf
      ? 'Add a comment'
      : 'What is happening?!';

  return (
    <div className={variant === 'inline' ? 'border-b border-border-default' : ''}>
      {post.isPending && <ProgressBar />}
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
          {quoteOf && <QuotedPost post={quoteOf} />}
          {expanded && (
            <div
              className={`mt-2 flex items-center justify-between gap-3 py-2 ${variant === 'inline' && (focused || text) ? 'border-t border-border-default' : ''} ${variant === 'modal' ? 'border-t border-border-default' : ''}`}
            >
              <span
                className="mono-caps flex items-center gap-1.5 text-[11px] leading-4 text-text-tertiary"
                title={
                  sponsored
                    ? 'Parallax pays the network fee of your post'
                    : 'Your wallet pays the network fee, in MON'
                }
              >
                <Icon name="gas" size={14} />
                {sponsored ? 'Gas sponsored' : 'Paid in MON'}
              </span>
              <div className="flex items-center gap-3">
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
