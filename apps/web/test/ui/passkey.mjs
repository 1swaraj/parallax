// Passkey accounts (mera) in Chromium, on the local stack, with Chrome's virtual authenticator standing in for the
// password manager: create a passkey and an account, post for free, reload without a passkey prompt, pay for a post
// from the passkey's own wallet (one prompt for the page), then sign out and sign in again with the same passkey.
//
//   APP_URL=http://localhost:3000 RPC_URL=http://127.0.0.1:8545 SHOTS_DIR=./shots node test/ui/passkey.mjs

import { APP, open, post, RPC_URL } from './harness.mjs';

const { createPublicClient, createTestClient, http, isAddressEqual, parseEther } =
  await import('viem');
const chain = createPublicClient({ transport: http(RPC_URL) });
const node = createTestClient({ mode: 'anvil', transport: http(RPC_URL) });

const { page, shot, step, finish } = await open();

// A platform authenticator with PRF, which the page sees as the password manager's passkeys.
const cdp = await page.context().newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
    hasPrf: true,
  },
});

/** Passkey prompts so far: the authenticator counts each sign-in (assertion) per passkey. */
async function prompts() {
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials.reduce((count, credential) => count + credential.signCount, 0);
}
/** Runs `fn` and checks it asked for the passkey `expected` times. */
async function expectPrompts(expected, fn) {
  const before = await prompts();
  await fn();
  const asked = (await prompts()) - before;
  if (asked !== expected) {
    throw new Error(`Expected ${expected} passkey prompt(s), got ${asked}`);
  }
}
// The connector's stored account (STORAGE_KEY in src/lib/passkey.ts, under wagmi's "wagmi." prefix).
const storedAccount = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('wagmi.passkey.account') ?? 'null'));
// Who pays network fees (GAS_MODE_KEY in src/lib/actions.tsx).
const setGasMode = (mode) => page.evaluate((m) => localStorage.setItem('lens:gas-mode', m), mode);

const signIn = page.getByRole('button', { name: /sign in with a passkey/i });
const createPasskey = page.getByRole('button', { name: 'Create an account', exact: true });
const username = `pk${Date.now().toString(36)}`;
let account;

await step('landing offers passkeys', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await createPasskey.waitFor();
  await signIn.waitFor();
  await shot('passkey-01-landing');
});

await step('create a passkey, then an account', async () => {
  await createPasskey.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  const field = dialog.getByLabel('Username');
  await field.waitFor({ timeout: 20000 });
  account = await storedAccount();
  await field.fill(username);
  await dialog.getByLabel('Display name (optional)').fill('Passkey Walkthrough');
  await page.waitForTimeout(600);
  await shot('passkey-02-create-account');
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 30000 });
  await page.getByRole('button', { name: 'New post' }).first().waitFor();
  console.log(`  passkey account ${account.address}`);
});

await step('post for free: the relayer pays, no passkey prompt', async () => {
  await expectPrompts(0, () => post(page, `Posted with a passkey account, for free. ${username}`));
  await shot('passkey-03-posted-free');
});

await step('reload: still signed in, no passkey prompt', async () => {
  await expectPrompts(0, async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: "What's new?" }).waitFor();
    await page.waitForTimeout(1000);
  });
});

await step('pay from the passkey wallet: one prompt, then none', async () => {
  await node.setBalance({ address: account.address, value: parseEther('10') });
  await setGasMode('direct');
  await page.reload({ waitUntil: 'networkidle' });
  await expectPrompts(1, () => post(page, `Paid from my passkey wallet. ${username}`));
  const { transactions } = await chain.getBlock({ includeTransactions: true });
  if (!transactions.some((tx) => isAddressEqual(tx.from, account.address))) {
    throw new Error(`The post wasn't sent by ${account.address}`);
  }
  await expectPrompts(0, () => post(page, `Paid again, no prompt this time. ${username}`));
  await setGasMode('sponsored');
  await shot('passkey-04-paid-from-wallet');
});

await step('sign out, then sign in again with the same passkey', async () => {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await signIn.click({ timeout: 15000 });
  await page.getByRole('button', { name: 'New post' }).first().waitFor({ timeout: 30000 });
  const again = await storedAccount();
  if (!isAddressEqual(again.address, account.address)) {
    throw new Error(`Signed in as ${again.address}, not ${account.address}`);
  }
  await shot('passkey-05-signed-in-again');
});

await finish();
