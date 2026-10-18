// What the UI scripts in this folder share: Chromium, the page, steps with screenshots, console errors and the summary.
// Needs playwright-core (PLAYWRIGHT_CORE to point at an install) and a Chromium (CHROMIUM_PATH).

import fs from 'node:fs';
import path from 'node:path';

export const APP = process.env.APP_URL ?? 'http://localhost:3000';
export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? './shots');

/** Opens a 1280×900 page. `setup(context)` runs before the page exists, e.g. to inject a wallet. */
export async function open(setup = async () => {}) {
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const failures = [];

  return {
    context,
    page,
    shot,
    async step(name, fn) {
      const started = Date.now();
      try {
        await fn();
        console.log(`✓ ${name} (${Date.now() - started}ms)`);
      } catch (error) {
        failures.push(name);
        await shot(`fail-${failures.length}`).catch(() => {});
        console.log(`✗ ${name}: ${error.message.split('\n')[0]}`);
      }
    },
    /** Closes the browser, lists the console errors, and exits 1 if a step failed. */
    async finish() {
      await browser.close();
      const relevant = [...new Set(errors)].filter(
        (error) => !/favicon|Download the React DevTools/.test(error)
      );
      if (relevant.length) {
        console.log(
          `Console errors (${relevant.length}):\n  ${relevant.slice(0, 10).join('\n  ')}`
        );
      }
      console.log(failures.length ? `${failures.length} step(s) failed` : 'All steps passed');
      process.exit(failures.length ? 1 : 0);
    },
  };
}

/** Posts from the home composer, and waits until the post shows. */
export async function post(page, text) {
  await page.getByRole('textbox', { name: "What's new?" }).fill(text);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText('Your post was sent.').first().waitFor({ timeout: 30000 });
  await page.getByText(text).first().waitFor({ timeout: 15000 });
}
