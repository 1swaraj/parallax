'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuthModal } from '@/components/modals';
import { Spinner } from '@/components/ui';

/** Old links to /onboarding open the sign-in flow on Home. */
export default function OnboardingPage() {
  const router = useRouter();
  const openAuth = useAuthModal();
  useEffect(() => {
    router.replace('/');
    openAuth();
  }, [router, openAuth]);
  return <Spinner />;
}
