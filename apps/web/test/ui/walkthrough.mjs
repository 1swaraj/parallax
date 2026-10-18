// Drives the app in Chromium like a user, on the local stack, with a dev wallet: sign in, create an account, post,
// reply, repost, follow, notifications, profile, settings, dark mode and mobile. Screenshots go to SHOTS_DIR.
//
//   APP_URL=http://localhost:3000 SHOTS_DIR=./shots node test/ui/walkthrough.mjs
//
// Needs playwright-core (PLAYWRIGHT_CORE to point at an install) and a Chromium (CHROMIUM_PATH).

import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? './shots');
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

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
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const username = `ui${Date.now().toString(36)}`;
// Wallet 1 is the one a person tries first: the walkthrough keeps out of its way.
const wallet = Number(process.env.DEV_WALLET ?? 3);

await step('home, signed out', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Home' }).waitFor();
  await shot('01-home-signed-out');
});

await step('sign in with a dev wallet', async () => {
  await page.getByRole('button', { name: /join parallax/i }).click();
  await page.getByRole('dialog', { name: 'Sign in' }).waitFor();
  await shot('02-sign-in-connect');
  await page.getByRole('button', { name: new RegExp(`Dev wallet ${wallet}`) }).click();
});

await step('create an account', async () => {
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  const field = dialog.getByLabel('Username');
  const needsAccount = await field
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (needsAccount) {
    await field.fill(username);
    await dialog.getByLabel('Display name (optional)').fill('UI Walkthrough');
    await dialog.getByLabel('Bio (optional)').fill('Testing Parallax end to end.');
    await page.waitForTimeout(600);
    await shot('03-create-account');
    await dialog.getByRole('button', { name: 'Create account' }).click();
  }
  await dialog.waitFor({ state: 'detached', timeout: 30000 });
  await page.getByRole('button', { name: 'New post' }).first().waitFor();
});

await step('post from the home composer', async () => {
  const box = page.getByRole('textbox', { name: 'What is happening?!' });
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
  await page.goto(`${APP}/u/${username}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'UI Walkthrough' }).first().waitFor();
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
  await page.goto(`${APP}/u/${username}`, { waitUntil: 'networkidle' });
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
