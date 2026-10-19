// Shared operator walkthrough steps. Requires a fresh managed database and SETUP_TOKEN on the web server.
export async function completeSetup(page, app, token) {
  await page.goto(`${app}/setup`, { waitUntil: 'networkidle' });
  await page.getByLabel('Setup token').fill(token);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Browser wallet' }).click();
  await page.getByRole('button', { name: 'Sign in with wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Claim instance', exact: true }).click();
  await page.getByRole('heading', { name: 'Branding', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save branding', exact: true }).click();
  await page.getByText('Saved. Changes apply within 10 seconds.').waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Check network', exact: true }).click();
  await page.getByText(/Both RPCs are on chain/).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // A local chain uses the public anvil relayer by default. Production operators supply their own keys.
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
}

export async function changeBrandAndPause(page, app) {
  await page.goto(`${app}/admin/branding`, { waitUntil: 'networkidle' });
  await page.getByLabel('App name', { exact: true }).fill('Walkthrough Community');
  await page.getByRole('button', { name: 'Save branding', exact: true }).click();
  await page.getByText('Saved. Changes apply within 10 seconds.').waitFor();
  await page.goto(app, { waitUntil: 'networkidle' });
  await page
    .getByRole('link', { name: 'Walkthrough Community home', exact: true })
    .first()
    .waitFor();
  await setPaused(page, app, true);
  await page.goto(app, { waitUntil: 'networkidle' });
  await page
    .getByRole('textbox', { name: "What's new?" })
    .fill('This sponsored post must be refused while paused.');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText(/isn't paying network fees right now/).waitFor();
  await setPaused(page, app, false);
  await page.goto(app, { waitUntil: 'networkidle' });
  // The following normal post step confirms the same sponsored path succeeds after unpausing.
}

export async function setPaused(page, app, paused) {
  await page.goto(`${app}/admin/sponsorship`, { waitUntil: 'networkidle' });
  await page.getByLabel('Pause sponsored actions').setChecked(paused);
  await page.getByRole('button', { name: 'Save sponsorship & limits', exact: true }).click();
  await page.getByText('Saved. Changes apply within 10 seconds.').waitFor();
}

export async function walkthroughModeration(page, app, screenshot) {
  await page.goto(`${app}/admin/moderation`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Moderation', exact: true }).waitFor();
  await page.getByLabel('Report status').selectOption('all');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByLabel('Word, domain or regex').fill('walkthrough-blocked-word');
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByText('Saved to the moderation log.').waitFor();
  await page
    .getByRole('button', { name: /^Remove filter/ })
    .first()
    .waitFor();
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
  await page
    .getByRole('button', { name: /^Remove filter/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Policy', exact: true }).click();
  await page.getByLabel('Home feed scope').selectOption('members');
  await page.getByRole('button', { name: 'Save moderation policy', exact: true }).click();
  await page.getByText('Moderation policy saved. Changes apply within 10 seconds.').waitFor();
  await page.getByLabel('Home feed scope').selectOption('network');
  await page.getByRole('button', { name: 'Save moderation policy', exact: true }).click();
  await page.goto(`${app}/admin/moderation-log`, { waitUntil: 'networkidle' });
  await page.getByText('moderation.filter', { exact: false }).first().waitFor();
  await page.goto(app, { waitUntil: 'networkidle' });
}
