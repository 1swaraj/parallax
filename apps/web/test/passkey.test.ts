// Passkey accounts (src/lib/passkey.ts) through wagmi's own actions, with a fake authenticator in place of the
// browser's WebAuthn: create, sign in at once, reload without a prompt, sign in again on another device.

import type { WebAuthnClient } from '@category-labs/mera';
import { bytesToHex, concat, hexToBytes, sha256, verifyMessage, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { createConfig, createStorage, http } from 'wagmi';
import { connect, disconnect, reconnect, signMessage } from 'wagmi/actions';
import { chain } from '@/lib/config';
import { passkeyConnectors } from '@/lib/passkey';

/** An authenticator that keeps passkeys in memory: the PRF output is a hash of the passkey's secret and the salt. */
function fakeAuthenticator({ prf = true } = {}) {
  const passkeys = new Map<Hex, Uint8Array>();
  let prompts = 0;
  let asked: WebAuthnClient.AllowCredential | undefined;
  const output = (secret: Uint8Array, salt: Uint8Array) =>
    hexToBytes(sha256(concat([secret, salt])));
  const client: WebAuthnClient = {
    async createCredential({ prfSalt }) {
      prompts += 1;
      const id = crypto.getRandomValues(new Uint8Array(16));
      const secret = crypto.getRandomValues(new Uint8Array(32));
      passkeys.set(bytesToHex(id), secret);
      return {
        credentialId: id,
        transports: ['internal'],
        prfEnabled: prf,
        prfOutput: prf ? output(secret, prfSalt) : undefined,
      };
    },
    async getCredential({ allowCredential, prfSalt }) {
      prompts += 1;
      asked = allowCredential;
      const id = allowCredential
        ? bytesToHex(allowCredential.credentialId)
        : passkeys.keys().next().value;
      const secret = id && passkeys.get(id);
      if (!id || !secret) {
        throw new DOMException(
          'The operation either timed out or was not allowed.',
          'NotAllowedError'
        );
      }
      return { credentialId: hexToBytes(id), prfOutput: prf ? output(secret, prfSalt) : undefined };
    },
  };
  return { client, prompts: () => prompts, asked: () => asked };
}

/** A page load: a new wagmi config. Pass the previous page's storage to reload, or none for another device. */
function page(
  authenticator: ReturnType<typeof fakeAuthenticator>,
  items = new Map<string, string>()
) {
  const config = createConfig({
    chains: [chain],
    connectors: passkeyConnectors({ rpId: 'localhost', webAuthnClient: authenticator.client }),
    transports: { [chain.id]: http() },
    storage: createStorage({
      storage: {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, value),
        removeItem: (key) => void items.delete(key),
      },
    }),
  });
  const [signIn, create] = config.connectors;
  return {
    config,
    items,
    signIn: () => connect(config, { connector: signIn! }),
    create: () => connect(config, { connector: create! }),
  };
}

describe('passkey accounts', () => {
  it('creates an account and signs in with it at once, with one prompt', async () => {
    const authenticator = fakeAuthenticator();
    const { config, items, create } = page(authenticator);
    const [address] = (await create()).accounts;
    expect(authenticator.prompts()).toBe(1);

    // The SIWE sign-in right after: the key is already in the page.
    const message = 'Sign in to Parallax';
    expect(
      await verifyMessage({ address, message, signature: await signMessage(config, { message }) })
    ).toBe(true);
    expect(authenticator.prompts()).toBe(1);

    // Signing out forgets the account: the next load doesn't reconnect.
    await disconnect(config);
    expect(await reconnect(page(authenticator, items).config)).toEqual([]);
  });

  it('reconnects after a reload without a prompt, and asks once at the first signature', async () => {
    const authenticator = fakeAuthenticator();
    const first = page(authenticator);
    const [address] = (await first.create()).accounts;

    const reloaded = page(authenticator, first.items);
    const [connection] = await reconnect(reloaded.config);
    expect(connection?.accounts).toEqual([address]);
    expect(authenticator.prompts()).toBe(1);

    for (const message of ['post', 'follow']) {
      const signature = await signMessage(reloaded.config, { message });
      expect(await verifyMessage({ address, message, signature })).toBe(true);
    }
    expect(authenticator.prompts()).toBe(2);
    // It asked for the passkey the account was made with, with the transports the platform reported then.
    expect(authenticator.asked()?.transports).toEqual(['internal']);
  });

  it('signs in with the same passkey on another device and gets the same account', async () => {
    const authenticator = fakeAuthenticator();
    const created = await page(authenticator).create();
    const signedIn = await page(authenticator).signIn();
    expect(signedIn.accounts).toEqual(created.accounts);
  });

  it('treats a closed prompt as a choice, and explains a passkey without PRF', async () => {
    await expect(page(fakeAuthenticator()).signIn()).rejects.toMatchObject({
      name: 'UserRejectedRequestError',
    });
    await expect(page(fakeAuthenticator({ prf: false })).create()).rejects.toThrow(
      /password manager doesn't support it/
    );
  });
});
