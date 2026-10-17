'use client';

import type { PostView } from '@lens-monad/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { atHandle, Avatar, NameLine, RelativeTime, RichText } from './account';
import { AuthFlow } from './auth';
import { Composer } from './composer';
import { EditProfile } from './edit-profile';
import { Button, CornerBrackets, Modal } from './ui';

type ComposeOptions = { replyTo?: PostView; quoteOf?: PostView };
type ConfirmOptions = {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
};

type Modals = {
  compose: (options?: ComposeOptions) => void;
  auth: () => void;
  confirm: (options: ConfirmOptions) => void;
  editProfile: () => void;
};

const ModalsContext = createContext<Modals | null>(null);

function useModals() {
  const modals = useContext(ModalsContext);
  if (!modals) {
    throw new Error('Modals used outside ModalsProvider');
  }
  return modals;
}

/** Opens the composer, as a reply or a quote when given a post. */
export const useCompose = () => useModals().compose;
/** Opens the connect, sign in, create account flow. */
export const useAuthModal = () => useModals().auth;
export const useConfirm = () => useModals().confirm;
export const useEditProfile = () => useModals().editProfile;

/** The post being replied to, above the composer, linked to it by the thread line. */
function ReplyContext({ post }: { post: PostView }) {
  return (
    <div className="flex gap-3 px-4 pt-4">
      <div className="flex w-10 shrink-0 flex-col items-center">
        <Avatar account={post.author} size={40} />
        <div className="mt-1 w-0.5 flex-1 bg-border-strong" />
      </div>
      <div className="min-w-0 flex-1 pb-2">
        <div className="flex min-w-0 items-baseline gap-1 text-sm">
          <NameLine account={post.author} link={false} />
          <span className="text-text-tertiary">·</span>
          <RelativeTime seconds={post.createdAt} />
        </div>
        {post.content && (
          <RichText text={post.content} className="mt-1 line-clamp-6 text-text-primary" />
        )}
        <div className="pt-3 text-sm text-text-tertiary">
          Replying to <span className="text-text-accent">{atHandle(post.author)}</span>
        </div>
      </div>
    </div>
  );
}

/** A technical confirmation: the bracketed MDS Modal, destructive action first, Cancel beside it. */
function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-overlay p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="animate-float relative w-full max-w-[400px] border border-border-default bg-bg-elevated p-6 shadow-float"
      >
        <CornerBrackets size={16} />
        <h2 id="confirm-title" className="text-2xl leading-8">
          {options.title}
        </h2>
        <p id="confirm-body" className="mt-2 text-sm text-text-secondary">
          {options.body}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancel} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={options.danger ? 'destructive' : 'primary'}
            onClick={() => {
              onClose();
              options.onConfirm();
            }}
          >
            {options.action}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function ModalsProvider({ children }: { children: ReactNode }) {
  const [compose, setCompose] = useState<ComposeOptions | null>(null);
  const [auth, setAuth] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const [editProfile, setEditProfile] = useState(false);

  const modals = useMemo<Modals>(
    () => ({
      compose: (options) => setCompose(options ?? {}),
      auth: () => setAuth(true),
      confirm: setConfirm,
      editProfile: () => setEditProfile(true),
    }),
    []
  );
  const closeCompose = useCallback(() => setCompose(null), []);
  const closeAuth = useCallback(() => setAuth(false), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const closeEditProfile = useCallback(() => setEditProfile(false), []);

  return (
    <ModalsContext.Provider value={modals}>
      {children}
      <Modal
        open={compose !== null}
        onClose={closeCompose}
        label={compose?.replyTo ? 'Reply' : compose?.quoteOf ? 'Quote' : 'New post'}
        title={compose?.replyTo ? 'Reply' : compose?.quoteOf ? 'Quote' : 'New post'}
      >
        {compose?.replyTo && <ReplyContext post={compose.replyTo} />}
        {compose && (
          <Composer
            key={compose.replyTo?.id ?? compose.quoteOf?.id ?? 'new'}
            variant="modal"
            replyTo={compose.replyTo}
            quoteOf={compose.quoteOf}
            autoFocus
            onPosted={closeCompose}
          />
        )}
      </Modal>
      <Modal open={auth} onClose={closeAuth} label="Sign in" width={520}>
        <AuthFlow onDone={closeAuth} />
      </Modal>
      {editProfile && <EditProfile onClose={closeEditProfile} />}
      {confirm && <ConfirmDialog options={confirm} onClose={closeConfirm} />}
    </ModalsContext.Provider>
  );
}
