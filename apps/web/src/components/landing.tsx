'use client';

import { useConnect, useConnection, useConnectors } from 'wagmi';
import { APP_NAME, APP_TAGLINE } from '@/lib/brand';
import { useSession } from '@/lib/session';
import { connectErrorToast, connectorAction, connectorIcon, SignOutButton } from './auth';
import { FooterLinks } from './footer-links';
import { Wordmark } from './brand';
import { Icon } from './icons';
import { useAuthModal } from './modals';
import { useToast } from './toast';
import { Button } from './ui';

/**
 * What signed-out visitors see instead of the app, like X's: the pitch and a way in, no timeline. A wallet button
 * connects, then the sign-in flow takes over (one signature, then a username if the wallet has no account).
 */
export function Landing() {
  const { owner, account } = useSession();
  const { isConnected } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending, variables } = useConnect();
  const openAuth = useAuthModal();
  const toast = useToast();

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
              connectors.map((connector, index) => (
                <Button
                  key={connector.uid}
                  variant={index === 0 ? 'primary' : 'secondary'}
                  disabled={isPending}
                  onClick={() =>
                    connect(
                      { connector },
                      { onSuccess: openAuth, onError: connectErrorToast(toast) }
                    )
                  }
                >
                  <Icon name={connectorIcon(connector)} size={16} />
                  {isPending && variables?.connector === connector
                    ? 'Connecting…'
                    : connectorAction(connector)}
                </Button>
              ))
            )}
            <p className="mt-2 text-xs text-text-tertiary">
              Joining and posting are free: {APP_NAME} pays the network fees. Your followers come
              with you to any Lens app.
            </p>
          </div>
        </div>
      </main>
      <footer className="px-6 pb-6">
        <FooterLinks className="justify-center" />
      </footer>
    </div>
  );
}
