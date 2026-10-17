'use client';

import { useEffect } from 'react';
import { APP_NAME } from './brand';

/** Puts the page first in the document title, for tabs, history and screen readers. */
export function usePageTitle(title: string | null) {
  useEffect(() => {
    if (title) {
      document.title = `${title} · ${APP_NAME}`;
    }
  }, [title]);
}
