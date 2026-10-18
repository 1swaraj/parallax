// Passkey accounts, with mera: see "Passkeys" in the README.
import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from '@category-labs/mera';
import { gasLimit } from '@lens-monad/protocol';
import {
  createClient,
  http,
  isAddressEqual,
  UserRejectedRequestError,
  type Address,
  type EstimateGasParameters,
  type LocalAccount,
} from 'viem';
import { toAccount } from 'viem/accounts';
import { estimateGas } from 'viem/actions';
import { createConnector } from 'wagmi';
import { APP_NAME } from './brand';

/** The connector type both passkey connectors share. */
export const PASSKEY = 'passkey';
/** The connector that creates a passkey: it can't connect to an account that already exists. */
export const NEW_PASSKEY = 'passkey-new';

const STORAGE_KEY = 'passkey.account';

/** What survives a reload: public data only, and which connector connected, so only that one reconnects. */
type StoredAccount = { credential: PasskeyCredentialMetadata; address: Address; connector: string };
/** What a passkey prompt gives: the passkey, with its transports when it was just created, and its PRF output. */
type Ceremony = PasskeyCredentialMetadata & { prfOutput: Uint8Array };
type Unlocked = { credential: PasskeyCredentialMetadata; account: LocalAccount; end: () => void };

/** What a failed passkey ceremony means to the user. A closed prompt is a choice: wagmi's callers stay quiet. */
function passkeyError(error: unknown): Error {
  if (isMeraError(error)) {
    switch (error.code) {
      case 'PASSKEY_OPERATION_FAILED':
        return new UserRejectedRequestError(error);
      case 'PRF_UNAVAILABLE':
        return new Error(
          "This passkey can't hold an account: its password manager doesn't support it yet. Try iCloud Keychain, Google Password Manager or 1Password."
        );
      case 'CRYPTO_UNAVAILABLE':
        return new Error('Passkeys need a secure connection (HTTPS).');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * One connector signs in with a passkey the user has, the other creates one: WebAuthn can't tell "no passkey" from
 * "cancelled", so one button can't do both. They share the page's signing session. Their names are the buttons' labels.
 */
export function passkeyConnectors({
  rpId = window.location.hostname,
  webAuthnClient,
}: { rpId?: string; webAuthnClient?: WebAuthnClient } = {}) {
  let unlocked: Unlocked | null = null;
  let unlocking: Promise<Unlocked> | null = null;

  function lock() {
    unlocked?.end();
    unlocked = null;
  }

  /** Waits for a passkey ceremony, then derives its account. The derivation code loads while the prompt is open. */
  async function unlock(ceremony: Promise<Ceremony>): Promise<Unlocked> {
    const derivation = import('./passkey-account');
    try {
      const { credentialId, transports, prfOutput } = await ceremony;
      const next = {
        credential: { credentialId, transports },
        ...(await derivation).unlockAccount(prfOutput),
      };
      lock();
      unlocked = next;
      return next;
    } catch (error) {
      throw passkeyError(error);
    }
  }

  /** The signed-in account's key: the passkey is asked for once per page, and only that passkey will do. */
  async function signer({ credential, address }: StoredAccount): Promise<LocalAccount> {
    if (unlocked && isAddressEqual(unlocked.account.address, address)) {
      return unlocked.account;
    }
    unlocking ??= unlock(getPasskeyPrfOutput({ rpId, credential, webAuthnClient })).finally(() => {
      unlocking = null;
    });
    const next = await unlocking;
    if (!isAddressEqual(next.account.address, address)) {
      lock();
      throw new Error('That passkey belongs to another account');
    }
    return next.account;
  }

  const connector = (id: string, name: string, ceremony: () => Promise<Ceremony>) =>
    createConnector<
      { request: ReturnType<typeof createClient>['request'] },
      Record<string, unknown>,
      { [STORAGE_KEY]: StoredAccount }
    >((config) => {
      const chain = config.chains[0];
      const transport = config.transports?.[chain.id] ?? http();
      const provider = { request: createClient({ chain, transport }).request };
      const stored = async () => (await config.storage?.getItem(STORAGE_KEY)) ?? null;

      return {
        id,
        name,
        type: PASSKEY,
        async connect({ isReconnecting } = {}) {
          let account = await stored();
          if (!isReconnecting || account?.connector !== id) {
            const { credential, account: signed } = await unlock(ceremony());
            account = { credential, address: signed.address, connector: id };
            await config.storage?.setItem(STORAGE_KEY, account);
          }
          return { accounts: [account.address] as never, chainId: chain.id };
        },
        async disconnect() {
          lock();
          await config.storage?.removeItem(STORAGE_KEY);
        },
        async getAccounts() {
          const account = await stored();
          return account ? [account.address] : [];
        },
        async getChainId() {
          return chain.id;
        },
        // wagmi's reconnect skips a connector without a provider; the client below does the work.
        async getProvider() {
          return provider;
        },
        /**
         * A client whose account asks for the passkey at its first signature, not before: after a reload the
         * address is known without a prompt, and sponsored actions never need one.
         */
        async getClient() {
          const account = await stored();
          if (!account) {
            throw new Error('Sign in with your passkey first');
          }
          return createClient({
            chain,
            transport,
            account: toAccount({
              address: account.address,
              signMessage: async (parameters) => (await signer(account)).signMessage(parameters),
              signTransaction: async (transaction, options) =>
                (await signer(account)).signTransaction(transaction, options),
              signTypedData: async (parameters) =>
                (await signer(account)).signTypedData(parameters),
            }),
          }).extend((client) => ({
            // viem prepares transactions through the client's estimateGas: the relayer's gas limit rule.
            estimateGas: async (parameters: EstimateGasParameters) =>
              gasLimit(await estimateGas(client, parameters)),
          }));
        },
        async isAuthorized() {
          return (await stored())?.connector === id;
        },
        onAccountsChanged() {},
        onChainChanged() {},
        onDisconnect() {},
      };
    });

  return [
    connector(PASSKEY, 'Sign in with a passkey', () =>
      getPasskeyPrfOutput({ rpId, webAuthnClient })
    ),
    connector(NEW_PASSKEY, 'Create an account with a passkey', () =>
      createPasskeyWithPrfOutput({
        rp: { id: rpId, name: APP_NAME },
        user: {
          name: `${APP_NAME} account`,
          displayName: `${APP_NAME} account, created ${new Date().toLocaleDateString()}`,
        },
        webAuthnClient,
      })
    ),
  ];
}
