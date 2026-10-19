'use client';

import { useEffect } from 'react';
import { useBrand } from '@/lib/runtime-config';

/** Puts the page first in the document title, for tabs, history and screen readers. */
export function usePageTitle(title: string | null) {
  const { APP_NAME } = useBrand();
  useEffect(() => {
    if (title) {
      document.title = `${title} · ${APP_NAME}`;
    }
  }, [title, APP_NAME]);
}
