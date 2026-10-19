'use client';

import { useConnection } from 'wagmi';
import { useBrand } from '@/lib/runtime-config';
import { useSession } from '@/lib/session';
import { SignInOptions, SignOutButton } from './auth';
import { FooterLinks } from './footer-links';
import { Wordmark } from './brand';
import { useAuthModal } from './modals';
import { Button } from './ui';

/**
 * What signed-out visitors see instead of the app, like X's: the pitch and a way in, no timeline. Passkeys come first
 * (SignInOptions). Once connected, the sign-in flow takes over: one signature, then a username for a new account.
 */
export function Landing() {
  const { APP_TAGLINE } = useBrand();
  const { owner, account } = useSession();
  const { isConnected } = useConnection();
  const openAuth = useAuthModal();

  return (
    <div className="flex min-h-dvh flex-col bg-bg-default">
      <main
        id="main"
        className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col justify-center gap-10 px-6 py-12 lg:flex-row-reverse lg:items-center lg:gap-16 lg:px-12"
      >
        <div className="flex lg:flex-1 lg:justify-center">
          <span className="lg:hidden">
            <Wordmark height={28} />
          </span>
          <Wordmark className="w-full max-w-[560px] max-lg:hidden" />
        </div>
        <div className="flex max-w-[480px] flex-col lg:flex-1">
          <h1 className="font-display text-5xl leading-[1.05] font-semibold tracking-[-0.02em] text-balance text-text-primary sm:text-6xl">
            {APP_TAGLINE}
          </h1>
          <p className="mt-10 mb-6 font-display text-2xl leading-8 font-medium text-text-primary sm:text-3xl">
            Join today.
          </p>
          <div className="flex w-full max-w-[340px] flex-col gap-3">
            {owner && !account ? (
              <>
                <Button variant="primary" onClick={openAuth}>
                  Pick your username
                </Button>
                <SignOutButton />
              </>
            ) : isConnected ? (
              <Button variant="primary" onClick={openAuth}>
                Sign in with your wallet
              </Button>
            ) : (
              <SignInOptions onConnected={openAuth} />
            )}
          </div>
        </div>
      </main>
      <footer className="px-6 pb-6">
        <FooterLinks className="justify-center" />
      </footer>
    </div>
  );
}
