'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useLensActions } from '@/lib/actions';
import { useBrand } from '@/lib/runtime-config';
import { MAX_BIO_CHARACTERS, MAX_NAME_CHARACTERS } from '@/lib/config';
import { useProfile } from '@/lib/indexer';
import { useSession } from '@/lib/session';
import { Avatar } from './account';
import { Field } from './auth';
import { useToast } from './toast';
import { Button, Modal, ProgressBar, Spinner } from './ui';

/** "Edit profile": Save in the title row, the avatar preview, then the fields. */
export function EditProfile({ onClose }: { onClose: () => void }) {
  const { APP_NAME } = useBrand();
  const { account } = useSession();
  const { data } = useProfile(account, null);
  const { updateProfile, sponsored } = useLensActions();
  const toast = useToast();
  const [form, setForm] = useState<{ name: string; bio: string; picture: string } | null>(null);
  const values = form ?? {
    name: data?.account.name ?? '',
    bio: data?.account.bio ?? '',
    picture: data?.account.picture ?? '',
  };
  const pictureError =
    values.picture && !/^https:\/\/\S+$/.test(values.picture)
      ? 'Use an https:// link to an image.'
      : null;

  const save = useMutation({
    mutationFn: () => updateProfile(values),
    onSuccess: () => {
      toast.show('Profile updated');
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      label="Edit profile"
      title="Edit profile"
      actions={
        <Button
          variant="primary"
          size="sm"
          disabled={!data || save.isPending || !!pictureError || form === null}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      {save.isPending && <ProgressBar />}
      {!data ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6 p-6" aria-busy={save.isPending}>
          <div className="flex items-center gap-4">
            <Avatar
              account={{
                ...data.account,
                picture: pictureError ? null : values.picture || null,
              }}
              size={64}
            />
            <div className="min-w-0 text-sm">
              <div className="truncate font-semibold text-text-primary">
                {values.name || data.account.username}
              </div>
              <div className="truncate text-text-tertiary">@{data.account.username}</div>
            </div>
          </div>
          <Field
            name="name"
            label="Display name"
            value={values.name}
            onChange={(name) => setForm({ ...values, name })}
            maxLength={MAX_NAME_CHARACTERS}
          />
          <Field
            name="bio"
            label="Bio"
            value={values.bio}
            onChange={(bio) => setForm({ ...values, bio })}
            maxLength={MAX_BIO_CHARACTERS}
            multiline
          />
          <Field
            name="picture"
            label="Picture URL"
            inputMode="url"
            value={values.picture}
            onChange={(picture) => setForm({ ...values, picture: picture.trim() })}
            placeholder="https://"
            error={pictureError}
            hint="A link to a square image."
          />
          <p className="text-xs text-text-tertiary">
            {sponsored
              ? `Saving is free: ${APP_NAME} pays the network fee.`
              : 'Saving sends a transaction from your wallet.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
