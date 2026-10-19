import type { InstanceConfig } from '../instance-schema';

/** The operator manual: the README's self-hosting section. */
export const OPERATOR_GUIDE_URL = 'https://github.com/1swaraj/parallax#running-your-own-instance';

const HEX = /^#[0-9a-fA-F]{6}$/;

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
}

/**
 * What every page shows until setup is finished: a note for visitors, and the way in for the operator. Plain HTML
 * from the proxy, so it keeps its 503 (search engines and uptime checks see an instance that isn't up yet).
 */
export function settingUpPage(
  config: Pick<InstanceConfig, 'appName' | 'tagline' | 'accentColor' | 'accentColorDark'>
) {
  const name = escape(config.appName);
  // Colors go into CSS: only well-formed hex, whatever the database holds.
  const accent = HEX.test(config.accentColor) ? config.accentColor : '#6e54ff';
  const accentDark = HEX.test(config.accentColorDark) ? config.accentColorDark : '#9f8fff';
  const steps = [
    'Enter the setup token (<code>SETUP_TOKEN</code>, or the one-time token in the server logs) and sign in with the wallet that will own this instance.',
    'Name it: tagline, logo, icon and colors.',
    'Check the network: app URL, RPCs and indexer.',
    "Choose whether it pays your users' network fees, and add relayer keys.",
    'Optionally add email (Resend) and choose who can sign up.',
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name} is being set up</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaff;--text:#0e091c;--muted:#5d5d70;--border:#e4e2ee;--accent:${accent};--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0e091c;--text:#f3f2f8;--muted:#a3a3b8;--border:#2b2640;--accent:${accentDark};--on-accent:#0e091c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:0 auto;padding:12vh 1.5rem 3rem}
img{border-radius:12px;display:block;margin-bottom:1.5rem}
h1{font-size:2rem;line-height:1.15;margin:0 0 .5rem;letter-spacing:-.01em}
h2{font-size:1rem;margin:0 0 .5rem}
p{margin:0 0 1rem;color:var(--muted)}
.tagline{font-size:1.125rem}
section{border:1px solid var(--border);border-radius:4px;padding:1.25rem;margin-top:2.5rem}
ol{margin:0 0 1.25rem;padding-left:1.25rem;color:var(--muted)}
li{margin:.25rem 0}
code{font:.875em ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}
a{color:var(--accent)}
a.primary{background:var(--accent);color:var(--on-accent);text-decoration:none;padding:.5rem 1rem;border-radius:4px;font:500 .875rem ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<main>
<img src="/icon" alt="" width="48" height="48">
<h1>${name} is being set up</h1>
<p class="tagline">${escape(config.tagline)}</p>
<p>It isn't open yet. Please check back soon.</p>
<section aria-labelledby="operator">
<h2 id="operator">Running this instance?</h2>
<p>Setup takes a few minutes:</p>
<ol>${steps.map((step) => `<li>${step}</li>`).join('')}</ol>
<p>Afterwards, everything stays editable in the admin panel at <code>/admin</code>.</p>
<div class="actions">
<a class="primary" href="/setup">Set up this instance</a>
<a href="${OPERATOR_GUIDE_URL}" rel="noopener">Operator guide</a>
<a href="/api/health">Status</a>
</div>
</section>
</main>
</body>
</html>`;
}
