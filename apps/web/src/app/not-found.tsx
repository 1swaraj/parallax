'use client';

import Link from 'next/link';
import { buttonClassName, EmptyState } from '@/components/ui';

export default function NotFound() {
  return (
    <EmptyState
      icon="search"
      title="This page doesn't exist"
      action={
        <Link href="/" className={buttonClassName()}>
          Go home
        </Link>
      }
    >
      The link may be broken, or the page may have moved.
    </EmptyState>
  );
}
