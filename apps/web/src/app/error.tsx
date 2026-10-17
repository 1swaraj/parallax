'use client';

import { Button, EmptyState } from '@/components/ui';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState
      icon="block"
      title="Something went wrong"
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    >
      This page hit an error. Trying again usually works.
    </EmptyState>
  );
}
