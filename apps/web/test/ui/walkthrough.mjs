// Drives the app in Chromium like a user, on the local stack: sign in, create an account, post, reply, repost, follow,
// notifications, profile, settings, dark mode and mobile. Screenshots go to SHOTS_DIR. The browser wallet is a test
// one, a fresh key each run that the page reaches as window.ethereum: it signs messages, the node answers the rest.
//
//   APP_URL=http://localhost:3000 SHOTS_DIR=./shots node test/ui/walkthrough.mjs
//
// Needs playwright-core (PLAYWRIGHT_CORE to point at an install) and a Chromium (CHROMIUM_PATH).

import { APP, open, RPC_URL } from './harness.mjs';
import { completeSetup, changeBrandAndPause } from './instance.mjs';

const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');

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

const { page, shot, step, finish } = await open(async (context) => {
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
});

const username = `ui${Date.now().toString(36)}`;
const profile = { handle: username, name: 'UI Walkthrough' };

if (process.env.SETUP_TOKEN) {
  await step('complete first-run setup', () => completeSetup(page, APP, process.env.SETUP_TOKEN));
}

await step('landing, signed out', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Your followers come with you.' }).waitFor();
  await shot('01-landing-signed-out');
});

await step('sign in with the browser wallet', async () => {
  // Passkeys come first; wallets are a click away.
  const wallets = page.getByRole('button', { name: 'Use a wallet instead' });
  if (await wallets.isVisible()) {
    await wallets.click();
  }
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

if (process.env.SETUP_TOKEN) {
  await step('change instance brand and refuse a paused sponsored post', () =>
    changeBrandAndPause(page, APP)
  );
}

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

await step('post an image', async () => {
  // A screenshot of the page makes a realistic picture to post: the app resizes and re-encodes it.
  const picture = await page.screenshot();
  await page.getByRole('link', { name: 'Home' }).first().click();
  await page.getByRole('textbox', { name: "What's new?" }).fill('An image, stored on Monad');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: picture,
  });
  await page.getByRole('img', { name: 'The image to post' }).waitFor();
  await page.getByRole('textbox', { name: 'Image description' }).fill('The Parallax timeline');
  await shot('07a-image-composer');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  // The composer empties once the chunks and the post are in; then the post shows in the feed.
  await page.getByRole('img', { name: 'The Parallax timeline' }).first().waitFor();
  await page
    .getByRole('textbox', { name: 'Image description' })
    .waitFor({ state: 'detached', timeout: 60000 });
  const posted = page
    .locator('article')
    .getByRole('img', { name: 'The Parallax timeline' })
    .first();
  await posted.waitFor({ timeout: 15000 });
  await page.waitForFunction((img) => img.complete, await posted.elementHandle());
  if (!(await posted.evaluate((img) => img.complete && img.naturalWidth > 0))) {
    throw new Error("The posted image didn't load");
  }
  await shot('07b-image-posted');
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

await finish();
