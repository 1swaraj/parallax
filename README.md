# Parallax

An X-style social app on [Lens Protocol V3](https://github.com/monad-developers/lens-monad-protocol), running on Monad.
Pick a username, post, reply, quote, repost, like, follow, block, get notified, search, and see what's trending.
Accounts, usernames, follows and posts are Lens contracts, so they come with you to any Lens app. Users don't need MON: Parallax's relayer pays
the gas through the protocol's `SponsorRouter`, and anyone can switch to paying from their own wallet.

```
apps/web          Next.js app, and its server: SIWE sessions, the relayer, likes (/api/*)
apps/indexer      Ponder indexer over the Lens contracts, with the REST API the app reads
packages/protocol ABIs, address books, calldata builders, Lens metadata, error messages, API types
scripts/          Local node + deployment, seed data, ABI and address book sync
```

## Features

- **Timelines:** Everyone and Following, infinite scroll, a "Show new posts" pill, and `n` to compose.
- **Posts:** replies, quote posts, reposts and undo, delete, threads with the full ancestor chain, @mentions,
  #hashtags and links, 280 characters.
- **People:** profiles, followers and following, who to follow, follow and block, and "Follows you".
- **Likes:** the heart, likes counts, and a private Likes tab. Lens V3 has no onchain likes, so these are Parallax's
  own, kept by its server, and other Lens apps don't see them.
- **Notifications:** follows, likes (grouped), replies, reposts, quotes and mentions, with an unread badge.
- **Explore:** people search, post search, hashtag search, and "What's happening" (the last week's hashtags).
- **Accounts:** connect, sign in with one free signature (SIWE), and pick a username. The first account is free.
- **Settings:** edit profile, light or dark mode, and who pays network fees.

## How it works

**Accounts.** A Lens account is an `Account` smart wallet owned by the user's wallet (EOA). Sign-up calls
`LensFactory.createAccountWithUsernameFree`: it creates the Account, gives it a username in the global `lens`
Namespace, adds the `SponsorRouter` as account manager (`canExecuteTransactions` and `canSetMetadataURI`, nothing that
moves funds), then hands the Account to the user's wallet.

**Writes.** Every action is a call the Account makes (`packages/protocol/src/calls.ts`): `Feed.createPost`,
`Graph.follow`, `AccountBlockingRule.blockUser`… The primitives check that the Account is the author, follower or
blocker, so a call can only ever act for the Account that makes it. It's sent one of two ways:

- **Sponsored** (default): the browser posts `{ target, data }` to `/api/relay`. The server checks the session (signed
  in with SIWE), checks onchain that the session's wallet still owns the Account and that the router is its manager,
  then a relayer sends `SponsorRouter.execute(account, target, data)`. The router only calls the functions the Safe
  allowlisted at launch.
- **Direct**: the user's wallet sends `Account.executeTransaction(target, 0, data)` and pays the gas in MON. No server
  involved. Settings switches between the two.

**Reads.** Ponder indexes the Lens events (accounts, usernames, posts, follows, blocks, mentions, hashtags) and serves
timelines, profiles, threads, notifications, search and trends (`apps/indexer/src/api`, typed in
`packages/protocol/src/api.ts`). After a write, the app waits for the indexer to reach the transaction's block before
refreshing. There's no hosted Lens API for this deployment, and the public RPCs cap `eth_getLogs` at 100 blocks, so reading the
chain from the browser doesn't scale.

**Content.** Posts and profiles are Lens metadata (`text-only` 3.0.0, `account` 1.0.0), inline in the contentURI as a
base64 `data:` URI, like the contracts' own token URIs, so there's no storage service to run.

## Run it locally

Needs Node 22+, pnpm 10, [Foundry](https://getfoundry.sh) 1.8.0+ (for `anvil --network monad`), and a built checkout
of `lens-monad-protocol` on the `feat/monad-launch` branch (SponsorRouter and launch scripts):

```sh
git clone -b feat/monad-launch --recurse-submodules git@github.com:monad-developers/lens-monad-protocol.git
(cd lens-monad-protocol && yarn && forge build)

pnpm install
LENS_CONTRACTS_DIR=../lens-monad-protocol pnpm chain   # terminal 1: local node, Lens deployment, seed data
pnpm indexer                                           # terminal 2: http://localhost:42069
pnpm web                                               # terminal 3: http://localhost:3000
pnpm seed:likes                                        # once the app runs: likes on the seeded posts
```

`pnpm chain` deploys with the protocol's own scripts (`DeployMonad`, then `DeployLaunch`), so the addresses are
deterministic and `packages/protocol/deployments/31337.json` stays valid. Then it seeds the chain (`scripts/seed.ts`):
14 people with names, bios and pictures, about 40 posts and replies spread over the last four days, quotes, reposts and
a follow graph, all through the same contracts and relayer the app uses (`SEED=0` to skip). The seed refuses any chain
but the local one: fake people don't belong on a public network. Restart `pnpm indexer` after restarting the chain.
Without `DATABASE_URL`, likes live in the web server's memory and go away when it restarts.

On the local chain, "Sign in" lists three **dev wallets** (anvil accounts the node signs for), so no extension is
needed. A browser wallet works too: add network `http://127.0.0.1:8545`, chain 31337.

## Tests

```sh
pnpm typecheck
pnpm test                                     # unit tests
pnpm test:e2e                                 # protocol flow against the local chain
pnpm --filter @lens-monad/indexer test:e2e    # the indexer's API (chain and indexer running)
pnpm --filter @lens-monad/web test:e2e        # the app's server end to end (chain, indexer and web running)
node apps/web/test/ui/walkthrough.mjs         # the UI in Chromium: sign up, post, reply, follow, dark mode, mobile
```

The web end-to-end tests read `/api/health`'s details, so run them with the server's `HEALTH_TOKEN` set. The UI
walkthrough needs `playwright-core` and a Chromium (`PLAYWRIGHT_CORE`, `CHROMIUM_PATH`), and saves screenshots
to `SHOTS_DIR`.

## Deploying to testnet or mainnet

Parallax runs as a Next.js app on Vercel (the pages and the relayer's API), and the indexer and Postgres on Railway.

1. **Address book.** Deploy the protocol (`lens-monad-protocol` README), then `LENS_CONTRACTS_DIR=… pnpm sync:contracts`:
   it copies `deployments/<chainId>.json` into `packages/protocol/deployments` and regenerates
   `packages/protocol/src/address-books.ts`, which every package imports. With only the JSON at hand, drop it in
   `packages/protocol/deployments` and run `pnpm sync:contracts --address-books`. Commit both files.
2. **Relayers.** Two or more keys, each allowlisted on the SponsorRouter (`RELAYERS` in `DeployLaunch`, or the Safe
   calls `setRelayer(relayer, true)`) and funded with MON. Each Account always goes through the same relayer, so its
   actions go out in order. Budget the funding with the gas budget below: at ~100 gwei,
   a sign-up costs ~0.23 MON and a post ~0.09 MON.
3. **Railway.** A Postgres service, and the indexer (`apps/indexer`: its `railway.json`, and its `.env.example` for
   `PONDER_CHAIN_ID`, `PONDER_RPC_URL`, `PONDER_GET_LOGS_RANGE` and `DATABASE_URL`). Give the indexer a public domain:
   it's the app's `INDEXER_URL`. The app keeps its own tables (relayer nonces, rate limits, the gas budget, and likes, which are
   Parallax's own and off-chain) in the `lens_web` schema of the same database.
4. **Vercel**, with the settings and variables below. Then check `https://<app>/api/health` answers 200, and point an
   uptime monitor at it.
5. Before the first launch, run the Postgres implementations' tests against a real Postgres (CI or a scratch Railway
   database): `TEST_DATABASE_URL=postgres://… pnpm --filter @lens-monad/web test`.

| Vercel setting   | Value                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Framework Preset | Next.js                                                                                        |
| Root Directory   | `apps/web`, with "Include files outside the root directory in the Build Step" on (the default) |
| Install Command  | `npx -y pnpm@10.27.0 install --frozen-lockfile` (runs from `apps/web`, installs the workspace) |
| Build Command    | `next build` (the default). Don't set `NEXT_DIST_DIR`                                          |
| Node.js Version  | 22.x or 24.x                                                                                   |
| Functions region | The Railway Postgres's (`iad1` for `us-east4`): an action makes ~15 database round trips       |
| Fluid compute    | On (the default). The sponsored routes set `maxDuration = 60`                                  |

| Variable                            | Where                              | What                                                                                                                      |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_CHAIN_ID`              | Vercel                             | `10143` (testnet) or `143`. Read at build time                                                                            |
| `NEXT_PUBLIC_RPC_URL`               | Vercel                             | The RPC browsers use. Public: no unrestricted API key                                                                     |
| `NEXT_PUBLIC_APP_URL`               | Vercel, Production only            | The app's public URL: sign-in messages must name its host. Read at build time                                             |
| `RPC_URL`                           | Vercel, sensitive                  | The server's RPC, e.g. a paid one. The public testnet RPC rate-limits per IP, which Vercel shares                         |
| `INDEXER_URL`                       | Vercel, for builds too             | The indexer's public URL. The `/indexer` proxy is compiled in: changing it takes a redeploy                               |
| `RELAYER_PRIVATE_KEYS`              | Vercel, sensitive, Production only | Comma-separated relayer keys (`RELAYER_PRIVATE_KEY` for a single one)                                                     |
| `SESSION_SECRET`                    | Vercel, sensitive                  | 32+ random characters (`openssl rand -hex 32`)                                                                            |
| `DATABASE_URL`                      | Vercel, sensitive                  | Railway Postgres's `DATABASE_PUBLIC_URL` + `?sslmode=require`. Required: without it, sponsoring answers 503               |
| `DATABASE_POOL_SIZE`                | Vercel                             | Connections per instance (5). Instances × size must fit Railway's `max_connections` (100 by default)                      |
| `SPONSOR_GAS_BUDGET_PER_HOUR`       | Vercel                             | Gas all relayers may spend per hour, e.g. `500000000` (~51 MON at 102 gwei). Required: without it, sponsoring answers 503 |
| `SPONSOR_MAX_GAS_PER_TX`            | Vercel                             | Highest gas limit one sponsored action may have (1500000). Over it: 400, the user can pay instead                         |
| `SPONSOR_MAX_GAS_PER_SIGNUP`        | Vercel                             | The same for a sponsored sign-up (3000000)                                                                                |
| `DISPLAY_FONT_URL`                  | Vercel, build                      | URL of the titles' font file, which isn't in this repo; the build downloads it. Unset: titles use Inter                   |
| `RELAY_PAUSED`                      | Vercel                             | `true` turns sponsored actions off (503). Takes a redeploy                                                                |
| `RELAY_RATE_LIMIT_PER_MINUTE`       | Vercel                             | Sponsored actions per Account per minute (30)                                                                             |
| `SIGNUP_RATE_LIMIT_PER_HOUR`        | Vercel                             | Sign-ups per owner per hour (3)                                                                                           |
| `SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR` | Vercel                             | Sign-ups per IP (IPv6: per /64) per hour (10)                                                                             |
| `SPONSOR_SIGNUPS_PER_HOUR`          | Vercel                             | Sign-ups in all per hour (200)                                                                                            |
| `LIKE_RATE_LIMIT_PER_MINUTE`        | Vercel                             | Likes and unlikes per Account per minute (60)                                                                             |
| `RELAYER_MIN_BALANCE_MON`           | Vercel                             | `/api/health` turns 503 when a relayer has less MON (5)                                                                   |
| `INDEXER_MAX_LAG_BLOCKS`            | Vercel                             | ... or when the indexer is more blocks behind (50)                                                                        |
| `HEALTH_TOKEN`                      | Vercel, sensitive                  | Bearer token that shows `/api/health`'s details. Unset: only the status                                                   |
| `PONDER_*`, `DATABASE_URL`          | Railway (indexer)                  | See `apps/indexer/.env.example`                                                                                           |

Scope the relayer keys and `DATABASE_URL` to Production. A preview deployment runs a branch's code: give previews
their own relayer and database, or none.

**Operating it.** `GET /api/health` answers `{"status":"ok"}` (200) or `"degraded"` (503). With
`Authorization: Bearer <HEALTH_TOKEN>` it also reports the chain, the head, each relayer's balance and allowlisting,
the indexer's lag, the database, the gas used this hour and whether relaying is paused, and lists the problems; it
never returns keys or URLs. To stop sponsoring, set `RELAY_PAUSED=true` and redeploy; to stop a relayer at once, the Safe
calls `setRelayer(relayer, false)` (its Accounts get a 503 until the key is removed or allowed again).

## Before production

- **Relayer spend.** The relayer only sends the calls the app makes (posts without rules, deletes, follows, blocks),
  each under a gas cap, within rate limits, an hourly gas budget and an hourly sign-up cap shared by every instance.
  EOAs are free and IPs cheap, so the budget is what bounds spend, and someone can use up the sign-up cap on purpose:
  sign-ups still need a check (captcha, or proof of personhood). Replies, quotes and follows still run the rules
  already on the target post or account; the gas cap bounds those.
- **Gas accounting.** The budget counts the receipts' `gasUsed`. Monad charges the gas limit (estimate + 10%): if its
  receipts report the gas used, the budget undercounts the MON spent by up to 10%.
- **Relayer throughput.** A relayer's nonce lock is held for a database read, two RPC calls and a write, so each key
  sends a few transactions per second, more with the database and RPC in the functions' region. Add keys to scale.
- **Lost broadcasts.** If the RPC accepts a transaction but its answer is lost (a timeout), the action is reported as
  failed though it may still go in, and a retry can duplicate it.
- **Pausing isn't instant.** `RELAY_PAUSED` takes a redeploy on Vercel (about a minute); `setRelayer(…, false)` from
  the Safe is immediate.
- **Source stamps.** Posts don't carry the reference App's source stamp yet, so they aren't attributed to an app.
- **Media.** Text only: images need a storage service.
- **Finality.** The app shows the result once the indexer saw the block. Monad's `latest` is a proposed block: anything
  that moves value should wait for `finalized`.
