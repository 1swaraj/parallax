'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuthModal } from '@/components/modals';
import { Spinner } from '@/components/ui';
import { MIRROR } from '@/lib/config';

/** Old links to /onboarding open the sign-in flow on Home (a mirror's client has no sign-up: Home). */
export default function OnboardingPage() {
  const router = useRouter();
  const openAuth = useAuthModal();
  useEffect(() => {
    router.replace('/');
    if (!MIRROR) openAuth();
  }, [router, openAuth]);
  return <Spinner />;
}
