// The read-only client of mirror mode in Chromium, against the local mirror (`pnpm mirror:chain`, the indexer with
// PONDER_MIRROR=true, the app built with NEXT_PUBLIC_MIRROR=true): readers browse without signing in, see the banner
// and the history's sync, and find nothing that writes; the server refuses writes; a wallet signs in and sees the
// Lens accounts it owns, their Following timeline and their notifications. The wallet is the demo's, anvil's 10th
// account (public key, local only), which owns @ana_lima and @ana_studio.
//
//   APP_URL=http://localhost:3000 SHOTS_DIR=./shots node test/ui/mirror.mjs
//
// Needs playwright-core (PLAYWRIGHT_CORE to point at an install) and a Chromium (CHROMIUM_PATH).

import { APP, open, RPC_URL } from './harness.mjs';

const { privateKeyToAccount } = await import('viem/accounts');

const wallet = privateKeyToAccount(
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
);
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
  // The wallet's side of window.ethereum's requests, as in walkthrough.mjs: it signs messages, and sends nothing.
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
        default:
          if (
            method.startsWith('wallet_') ||
            method.startsWith('eth_sign') ||
            method.startsWith('eth_send')
          ) {
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

/** Fails when the page has what it shouldn't. */
async function none(locator, what) {
  const count = await locator.count();
  if (count > 0) {
    throw new Error(`${count} ${what}`);
  }
}

const main = () => page.locator('main');

await step('signed out, Home reads the mirror', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByText('Read-only preview.').waitFor();
  await page
    .getByText(/History sync(ed|ing)/)
    .first()
    .waitFor();
  await main().getByText('Working on a zine about onchain social').first().waitFor();
  await shot('mirror-01-home-signed-out');
});

await step('Home has nothing that writes', async () => {
  await none(page.getByRole('button', { name: 'New post' }), 'New post buttons');
  await none(page.getByRole('textbox', { name: "What's new?" }), 'composers');
  await none(page.getByRole('button', { name: /^(Like|Unlike)\b/ }), 'like buttons');
  await none(
    page.getByRole('button', { name: /^(Reply|Repost|Undo repost)\b/ }),
    'reply or repost buttons'
  );
  await none(page.getByRole('button', { name: /^(Follow|Following)$/ }), 'follow buttons');
  // Replies, reposts and quotes are counts.
  await main().getByLabel('2 replies').first().waitFor();
});

await step('the Everyone timeline leaves out accounts no one follows', async () => {
  await none(main().getByText('Claim free MON'), 'posts by the followerless spam account');
  await page.goto(`${APP}/u/free_mon_claims`, { waitUntil: 'networkidle' });
  await main().getByText('Claim free MON').waitFor();
});

await step('a thread has no reply box', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await main().getByText('Working on a zine about onchain social').first().click();
  await page.getByRole('heading', { name: 'Post', exact: true }).waitFor();
  await main().getByText('Count me in, and cc').waitFor();
  await none(page.getByRole('textbox'), 'text boxes');
  await shot('mirror-02-thread');
});

await step('a profile is read-only, and says where it was mirrored from', async () => {
  await page.goto(`${APP}/u/ana_lima`, { waitUntil: 'networkidle' });
  await main()
    .getByText(/Mirrored from Lens Chain/)
    .waitFor();
  await none(page.getByRole('button', { name: 'Edit profile' }), 'Edit profile buttons');
  await none(
    page.getByRole('button', { name: /^(Follow|Following|Blocked)$/ }),
    'follow or block buttons'
  );
  await none(main().getByText(/^Joined /), 'join dates');
  await shot('mirror-03-profile');
});

await step('media and unreadable metadata are links', async () => {
  await page.goto(`${APP}/u/kai_lens`, { waitUntil: 'networkidle' });
  await main().getByRole('link', { name: /Video/ }).first().waitFor();
  await page.goto(`${APP}/u/marco_p`, { waitUntil: 'networkidle' });
  await main().getByText("This post's content is stored offchain.").waitFor();
  await main()
    .getByRole('link', { name: /Post metadata/ })
    .waitFor();
  await shot('mirror-04-offchain');
});

await step('the server refuses writes', async () => {
  const statuses = await page.evaluate(() =>
    Promise.all(
      ['/api/relay', '/api/signup', '/api/profile', '/api/likes'].map((path) =>
        fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).then((response) => response.status)
      )
    )
  );
  if (statuses.some((status) => status !== 403)) {
    throw new Error(`Writes answered ${statuses.join(', ')}`);
  }
});

await step('sign in with a wallet, which shows its Lens account', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign in with your wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.waitFor();
  await none(dialog.getByRole('button', { name: /passkey|Create an account/i }), 'passkey options');
  await shot('mirror-05-sign-in');
  await dialog.getByRole('button', { name: /continue with browser wallet/i }).click();
  await dialog.waitFor({ state: 'detached', timeout: 30000 });
  await page.getByRole('button', { name: 'Account menu' }).getByText('Ana Lima').waitFor();
});

await step('the Following timeline', async () => {
  await page.getByRole('tab', { name: 'Following' }).click();
  await main().getByText("Ana's first post on Lens, still a classic.").waitFor();
  await none(page.getByRole('button', { name: 'New post' }), 'New post buttons');
  await shot('mirror-06-following');
});

await step('notifications are the activity from after the mirror started', async () => {
  await page.goto(`${APP}/notifications`, { waitUntil: 'networkidle' });
  await main().getByText('Count me in, and cc').waitFor();
  await main().getByText("Ana's first post on Lens, still a classic.").waitFor();
  // History doesn't notify: Kai's older reply and Zoë's older mention.
  await none(main().getByText('Me! @lens/ana_lima'), 'notifications from history');
  await shot('mirror-07-notifications');
});

await step('switch to the wallet’s other account', async () => {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Switch to @ana_studio' }).click();
  await page.getByRole('button', { name: 'Account menu' }).getByText('Ana Lima Studio').waitFor();
  await page.goto(`${APP}/notifications`, { waitUntil: 'networkidle' });
  await main().getByText('followed you').waitFor();
  await main().getByText('reposted your post').waitFor();
});

await step('settings write nothing', async () => {
  await page.goto(`${APP}/settings`, { waitUntil: 'networkidle' });
  await main().getByText('Your wallet also owns:').waitFor();
  await none(page.getByRole('heading', { name: 'Network fees' }), 'network fee settings');
  await none(page.getByRole('button', { name: 'Edit profile' }), 'Edit profile buttons');
  await main()
    .getByText(/reads a mirror of Lens Chain/)
    .waitFor();
  await shot('mirror-08-settings');
});

await step('mobile', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByText('Read-only preview.').waitFor();
  await none(page.getByRole('button', { name: 'New post' }), 'New post buttons');
  await shot('mirror-09-mobile');
});

await finish();
