'use client';

import { follow, unfollow, type AccountView, type Relationship } from '@lens-monad/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { isAddressEqual } from 'viem';
import { useLensActions } from '@/lib/actions';
import { contracts } from '@/lib/config';
import { useProfile } from '@/lib/indexer';
import { useAuthModal } from './modals';
import { useToast } from './toast';
import { Button } from './ui';

/**
 * Follow / Following. Secondary everywhere but a profile header (`primary`), so a list never shows several primary
 * buttons. Takes the relationship when the caller batch-loaded it, fetches it otherwise. Flips optimistically.
 */
export function FollowButton({
  target,
  relationship,
  primary = false,
}: {
  target: AccountView;
  relationship?: Relationship | null;
  primary?: boolean;
}) {
  const { run, account } = useLensActions();
  const openAuth = useAuthModal();
  const { data } = useProfile(
    relationship === undefined && account ? target.address : null,
    account
  );
  const toast = useToast();
  const [hovered, setHovered] = useState(false);
  const known = relationship ?? data?.relationship ?? null;
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const following = optimistic ?? known?.following ?? false;

  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      run((viewer) =>
        next
          ? follow(contracts.LensGlobalGraph, viewer, target.address)
          : unfollow(contracts.LensGlobalGraph, viewer, target.address)
      ),
    onMutate: (next) => setOptimistic(next),
    onSettled: () => setOptimistic(null),
    onError: (error) => toast.error(error.message),
  });

  if (account && isAddressEqual(account, target.address)) {
    return null;
  }
  if (known?.blockedBy || known?.blocking) {
    return null;
  }
  const unfollowing = following && hovered;
  return (
    <Button
      size="sm"
      variant={following ? 'secondary' : primary ? 'primary' : 'secondary'}
      disabled={toggle.isPending}
      aria-pressed={following}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!account) {
          openAuth();
          return;
        }
        toggle.mutate(!following);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`min-w-[96px] ${unfollowing ? 'text-status-error' : ''}`}
    >
      {following ? (unfollowing ? 'Unfollow' : 'Following') : 'Follow'}
    </Button>
  );
}
