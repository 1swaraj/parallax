// Drives the app in Chromium like a user, on the local stack: sign in, create an account, post, reply, repost, follow,
// notifications, profile, settings, dark mode and mobile. Screenshots go to SHOTS_DIR. The browser wallet is a test
// one, a fresh key each run that the page reaches as window.ethereum: it signs messages, the node answers the rest.
//
//   APP_URL=http://localhost:3000 SHOTS_DIR=./shots node test/ui/walkthrough.mjs
//
// Needs playwright-core (PLAYWRIGHT_CORE to point at an install) and a Chromium (CHROMIUM_PATH).

import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? './shots');
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');

fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  // A single process: some sandboxes refuse Chromium's helper processes.
  args: ['--single-process', '--no-sandbox', '--disable-gpu'],
  // Behind an authenticating proxy (e.g. a sandbox), external images (avatars) load through it.
  ...(process.env.HTTPS_PROXY
    ? (() => {
        const proxy = new URL(process.env.HTTPS_PROXY);
        return {
          proxy: {
            server: `${proxy.protocol}//${proxy.host}`,
            username: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password),
            bypass: 'localhost,127.0.0.1',
          },
        };
      })()
    : {}),
});

const failures = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push(name);
    await page
      .screenshot({ path: path.join(SHOTS, `fail-${failures.length}.png`) })
      .catch(() => {});
    console.log(`✗ ${name}: ${error.message.split('\n')[0]}`);
  }
};

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const wallet = privateKeyToAccount(generatePrivateKey());
const chainId = await rpc('eth_chainId', []);

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) {
    throw Object.assign(new Error(body.error.message), { code: body.error.code });
  }
  return body.result;
}

// The wallet's side of window.ethereum's requests. Errors go back as values: thrown ones lose their code on the way.
await context.exposeFunction('testWalletRequest', async (method, params = []) => {
  try {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { result: [wallet.address] };
      case 'eth_chainId':
        return { result: chainId };
      case 'personal_sign':
        return { result: await wallet.signMessage({ message: { raw: params[0] } }) };
      case 'wallet_switchEthereumChain':
        return params[0]?.chainId === chainId
          ? { result: null }
          : { error: { code: 4902, message: 'Unknown chain' } };
      default:
        if (method.startsWith('wallet_') || method.startsWith('eth_sign')) {
          return { error: { code: 4200, message: `${method} is not supported` } };
        }
        return { result: await rpc(method, params) };
    }
  } catch (error) {
    return { error: { code: error.code ?? -32603, message: error.message } };
  }
});
await context.addInitScript(() => {
  window.ethereum = {
    async request({ method, params }) {
      const { result, error } = await window.testWalletRequest(method, params);
      if (error) {
        throw Object.assign(new Error(error.message), error);
      }
      return result;
    },
    on() {},
    removeListener() {},
  };
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const username = `ui${Date.now().toString(36)}`;
const profile = { handle: username, name: 'UI Walkthrough' };

await step('landing, signed out', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Your followers come with you.' }).waitFor();
  await shot('01-landing-signed-out');
});

await step('sign in with the browser wallet', async () => {
  await page.getByRole('button', { name: /continue with browser wallet/i }).click();
  await page.getByRole('dialog', { name: 'Sign in' }).waitFor();
  await shot('02-sign-in');
});

await step('create an account', async () => {
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  const field = dialog.getByLabel('Username');
  await field.waitFor({ timeout: 20000 });
  await field.fill(username);
  await dialog.getByLabel('Display name (optional)').fill(profile.name);
  await dialog.getByLabel('Bio (optional)').fill('Testing Parallax end to end.');
  await page.waitForTimeout(600);
  await shot('03-create-account');
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 30000 });
  await page.getByRole('button', { name: 'New post' }).first().waitFor();
});

await step('post from the home composer', async () => {
  const box = page.getByRole('textbox', { name: "What's new?" });
  await box.fill('gm from the Parallax walkthrough. #parallax @nobody');
  await shot('04-composer');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText('Your post was sent.').waitFor({ timeout: 30000 });
  await page.getByText('gm from the Parallax walkthrough.').first().waitFor({ timeout: 15000 });
  await shot('05-posted');
});

await step('reply in the modal', async () => {
  await page
    .locator('article')
    .first()
    .getByRole('button', { name: /^Reply/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Reply' });
  await dialog.getByRole('textbox').fill('Replying to myself.');
  await shot('06-reply-modal');
  await dialog.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByText('Your reply was sent.').waitFor({ timeout: 30000 });
});

await step('open the thread', async () => {
  await page.getByText('gm from the Parallax walkthrough.').first().click();
  await page.getByRole('heading', { name: 'Post' }).waitFor();
  await page.getByText('Replying to myself.').waitFor({ timeout: 15000 });
  await shot('07-thread');
});

await step('follow someone from Explore', async () => {
  await page.goto(`${APP}/explore`, { waitUntil: 'networkidle' });
  await page.locator('main').getByRole('heading', { name: 'Who to follow' }).waitFor();
  const follow = page.locator('main').getByRole('button', { name: 'Follow', exact: true }).first();
  await follow.click();
  await page
    .locator('main')
    .getByRole('button', { name: 'Following' })
    .first()
    .waitFor({ timeout: 30000 });
  await shot('08-explore');
});

await step('profile', async () => {
  await page.goto(`${APP}/u/${profile.handle}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: profile.name }).first().waitFor();
  await shot('09-profile');
});

await step('notifications', async () => {
  await page.goto(`${APP}/notifications`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  await shot('10-notifications');
});

await step('settings and dark mode', async () => {
  await page.goto(`${APP}/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.waitForTimeout(200);
  await shot('11-settings-dark');
  await page.goto(APP, { waitUntil: 'networkidle' });
  await shot('12-home-dark');
  await page.goto(`${APP}/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Light' }).click();
});

await step('mobile', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(APP, { waitUntil: 'networkidle' });
  await shot('13-mobile-home');
  await page.goto(`${APP}/u/${profile.handle}`, { waitUntil: 'networkidle' });
  await shot('14-mobile-profile');
});

await browser.close();
const relevant = errors.filter((error) => !/favicon|Download the React DevTools/.test(error));
if (relevant.length) {
  console.log(
    `Console errors (${relevant.length}):\n  ${[...new Set(relevant)].slice(0, 10).join('\n  ')}`
  );
}
console.log(failures.length ? `${failures.length} step(s) failed` : 'All steps passed');
process.exit(failures.length ? 1 : 0);
