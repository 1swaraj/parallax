# Parallax

An X-style social app on [Lens Protocol V3](https://github.com/monad-developers/lens-monad-protocol), running on Monad.
Pick a username, post, reply, quote, repost, like, follow, block, get notified, search, and see what's trending.
Accounts, usernames, follows and posts are Lens contracts, so they come with you to any Lens app. Users don't need MON: Parallax's relayer pays
the gas through the protocol's `SponsorRouter`, and anyone can switch to paying from their own wallet.

```
apps/web          Next.js app, and its server: SIWE sessions, the relayer, likes (/api/*)
apps/indexer      Ponder indexer over the Lens contracts, with the REST API the app reads
packages/protocol ABIs, address books, calldata builders, Lens metadata, error messages, API types
contracts/        Parallax's own contract: MediaStore, for post images
scripts/          Local node + deployment, seed data, ABI and address book sync
```

## Features

- **Timelines:** Everyone and Following, infinite scroll, a "Show new posts" pill, and `n` to compose.
- **Posts:** replies, quote posts, reposts and undo, delete, threads with the full ancestor chain, @mentions,
  #hashtags and links, 280 characters.
- **Images:** one image per post, with a description. Stored on Monad itself, not on a storage service: see Images
  below.
- **People:** profiles, followers and following, who to follow, follow and block, and "Follows you".
- **Likes:** the heart, likes counts, and a private Likes tab. Lens V3 has no onchain likes, so these are Parallax's
  own, kept by its server, and other Lens apps don't see them.
- **Notifications:** follows, likes (grouped), replies, reposts, quotes and mentions, with an unread badge.
- **Explore:** people search, post search, hashtag search, and "Trending" (the last week's hashtags).
- **Accounts:** connect a wallet or use a passkey, sign in with one free signature (SIWE), and pick a username. The
  first account is free.
- **Settings:** edit profile, light or dark mode, and who pays network fees.

## How it works

**Accounts.** A Lens account is an `Account` smart wallet owned by the user's wallet (EOA). Sign-up calls
`LensFactory.createAccountWithUsernameFree`: it creates the Account, gives it a username in the global `lens`
Namespace, adds the `SponsorRouter` as account manager (`canExecuteTransactions` and `canSetMetadataURI`, nothing that
moves funds), then hands the Account to the user's wallet.

**Passkeys.** People without a wallet can use a passkey instead ([mera](https://mera.category.xyz),
`apps/web/src/lib/passkey.ts`): the passkey's PRF output seeds an EOA, so the same passkey brings back the same account
on every device it syncs to, with no seed phrase and no key on a server. Only apps that derive the key the same way
(`passkey-account.ts`) get that account from the passkey, so the derivation can't change. "Create an account with a
passkey" makes one, "Sign in with a passkey" uses one. The key lives in the page's memory from the first signature until
the page closes or the user signs out, and the code that derives it loads only once a passkey prompt is open. After a
reload the app knows the address without asking, and asks for the passkey only when something needs a signature; once
signed in, sponsored actions don't. Passkeys belong to the site's domain, so an account made on one domain (or on
`localhost`) doesn't exist on another. The password manager has to support the PRF extension: iCloud Keychain, Google
Password Manager and 1Password do. `NEXT_PUBLIC_PASSKEYS=false` turns it off.

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

**Content.** Posts and profiles are Lens metadata (`text-only` 3.0.0, `image` 3.0.0, `account` 1.0.0), inline in the
contentURI as a base64 `data:` URI, like the contracts' own token URIs, so there's no storage service to run.

**Images.** An image is too big for the post's metadata: the Feed stores the contentURI, and a fresh 32-byte storage
slot costs 27,900 gas on Monad ([opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)), ~870
gas a byte. So images go in the chain's history instead, the way
[streaming-pod](https://github.com/1swaraj/streaming-pod) streams video over Monad, at ~40 gas a byte:

1. The browser resizes the image to 1280px on its longest side and re-encodes it as WebP (JPEG where the browser can't
   encode WebP) at the best quality that fits 120 KB (`lib/images.ts`). Re-encoding also drops the file's metadata,
   e.g. a photo's location, which would otherwise be public for good.
2. The Account calls `MediaStore.put(id, offset, bytes)` once per 64 KB, sponsored or from the wallet like any other
   action. `MediaStore` (`contracts/src/MediaStore.sol`) only emits the bytes as a log: the author is the Account
   that called it, and the id is the image's SHA-256. 64 KB transactions are known to go through on Monad mainnet
   (streaming-pod sends them); the docs give a 30M gas limit per transaction but no size limit.
3. The post is Lens `image` metadata. Its `item` is `https://<app>/media/<account>/<id>`, so other Lens apps can show
   it, and its `onchain` attribute says where the bytes are (`eip155:<chain>:<MediaStore>/<account>/<id>`), so anyone
   can rebuild the image from the logs without Parallax.
4. The indexer keeps the chunks (`media_chunk`), and `/media/<account>/<id>` puts them back together. It serves them
   only once their SHA-256 is the id, and only as the image type their first bytes say (JPEG, PNG, WebP or GIF), never
   as HTML or SVG, and sandboxed. The bytes behind an id never change, so they're cached for good.

Measured on `anvil --network monad`: a 64 KB chunk uses 2.64M gas (a 2.9M limit, which Monad charges), and a post
with an image ~1.3M, its metadata being bigger. So a full 120 KB image costs ~6.8M gas with its post, ~0.7 MON at
102 gwei, and a typical 50 KB one ~3.6M (~0.37 MON), against ~0.8M for a text post. The ~40 gas a byte is EIP-7623's
calldata floor, which anvil's Monad mode applies; Monad's docs say costs they don't list are Ethereum's, and don't
mention EIP-7623, so check the figure on testnet. `MediaStore` is deployed through the CREATE2 factory at
`0x4e59b44847b379578588920ca78fbf26c0b4956c` ([network information](https://docs.monad.xyz/developer-essentials/network-information)),
so it has the same address on every chain. Images are only offered on chains listed in
`MEDIA_STORE_DEPLOYMENTS` (`packages/protocol/src/media.ts`).

## Architecture

```
Browser
 ├─ pages, /api/*          → Next.js on Vercel
 │                             ├─ /api/signup, /api/relay, /api/profile → a relayer key → Monad RPC
 │                             ├─ /api/auth/*, /api/likes/*             → session cookie, Postgres
 │                             └─ /indexer/* (a rewrite)                → the indexer
 └─ direct mode, wallet    → Monad RPC: Account.executeTransaction, no server

Ponder indexer on Railway  ← Lens events from Monad RPC, and serves the app's reads
Postgres on Railway        ← the indexer's tables, and the app's own in the lens_web schema
```

The web server is stateless apart from Postgres: sessions are encrypted cookies (iron-session), and what instances
share lives in `lens_web`: relayer nonces, rate limits, the hourly gas budget, and likes. Without `DATABASE_URL`
(local development), the same state lives in the process's memory.

**A sponsored action, step by step** (`apps/web/src/lib/server/chain.ts`, `sendAsRelayer`):

1. **Guards.** Sponsoring isn't paused and its limits are set; the request is JSON from the app's own origin; the
   session signed in with SIWE. `/api/relay` only takes the calls the app makes (`sponsor.ts`), checks onchain that
   the session's wallet still owns the Account and that the router is its manager, and rate-limits per Account.
   Sign-ups are rate-limited per owner, per IP and overall.
2. **Relayer.** The actor (the Account, or the owner for a sign-up) is hashed to one of `RELAYER_PRIVATE_KEYS`.
3. **Simulation.** A revert costs nothing and comes back as the contract's error. The gas limit is the estimate plus
   10% (Monad charges the limit, so it stays tight), refused over `SPONSOR_MAX_GAS_PER_TX` (`_PER_SIGNUP` for sign-ups).
4. **Fees.** The fee cap is twice the base fee plus the tip. Monad charges the gas limit times the base fee plus the
   tip, capped by the fee cap ([gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing)), so the headroom
   costs nothing; a transaction whose cap the base fee rises past isn't included, and holds up its relayer (below).
5. **Budget.** The gas limit is reserved in this hour's `SPONSOR_GAS_BUDGET_PER_HOUR`, or the action gets a 503.
6. **Nonce and broadcast**, under the relayer's lock (below).
7. **Receipt**, outside the lock, for up to 30s; past that the action answers 504 "sent, not confirmed". The budget
   is settled to the receipt's `gasUsed`, and what the call created (a post id, an Account) is read from its logs.
8. The browser waits for the indexer to reach the receipt's block, then refreshes.

**Relayers and nonces** (`nonces.ts`, `relayers.ts`). Each key is one nonce sequence. An Account always goes through
the same key, so its actions go out in order; different keys send in parallel, so throughput grows with the number
of keys. For each relayer, Postgres keeps the next nonce to use, the chain's count last time it looked, and when that
last moved. A request takes the relayer's lock, reads the chain's count, uses the larger of the two, broadcasts, saves,
and lets go: many transactions per relayer are in flight at once, and nothing waits for a receipt under the lock. On
Monad, `pending` is the same as `latest` ([RPC differences](https://docs.monad.xyz/reference/rpc-differences)), so
the chain's count never includes transactions in flight: the saved nonce is what keeps them apart.

- **The lock.** A Postgres advisory lock per relayer orders requests across instances. Within an instance, a relayer's
  requests queue in memory before asking for a connection, so each relayer holds at most one, from a pool of its own
  (one connection per key). Requests waiting on a busy relayer can't take the connections other relayers, rate limits
  and likes need. A request that waited 15s in all gets a 503.
- **Recovery.** A nonce the node says is taken is skipped and the broadcast retried, up to 3 times; a gap the node
  reports goes back to the chain's count; a nonce error for a transaction the node already has counts as sent.
  Monad's RPC accepts transactions with a nonce gap rather than refusing them, so there a dropped transaction shows up
  as a stall instead: if the chain's count stays behind ours for 30s without moving, every later transaction waits
  behind a missing one, and the nonces are reused from the chain's. A saved state far ahead of the chain, or a chain
  whose count went back, is a restarted chain or a restored database, and is dropped at once.
- **Throughput.** The lock is held for about four database round trips and two RPC calls: roughly 3 transactions per
  second per key with Postgres in another region, 10 or more with Postgres and the RPC next to the functions.

## Run it locally

Needs Node 22+, pnpm 10, [Foundry](https://getfoundry.sh) 1.8.0+ (for `anvil --network monad`), and a built checkout
of `lens-monad-protocol` at the reviewed PR #4 revision (SponsorRouter and staged address-book scripts):

```sh
git clone --recurse-submodules git@github.com:monad-developers/lens-monad-protocol.git
(cd lens-monad-protocol && git fetch origin pull/4/head && git checkout 02da644aebe224a3614fab2cdb4e1162c9d4a9c0 && git submodule update --init --recursive && yarn && forge build)

pnpm install
LENS_CONTRACTS_DIR=../lens-monad-protocol pnpm chain   # terminal 1: local node, Lens deployment, seed data
pnpm indexer                                           # terminal 2: http://localhost:42069
pnpm web                                               # terminal 3: http://localhost:3000
pnpm seed:likes                                        # once the app runs: likes on the seeded posts
```

`pnpm chain` deploys with the protocol's own scripts (`DeployMonad`, then `DeployLaunch`), so the addresses are
deterministic and `packages/protocol/deployments/31337.json` stays valid. Then it seeds the chain (`scripts/seed.ts`):
14 people with names, bios and pictures, about 40 posts and replies spread over the last four days, quotes, reposts and
a follow graph, all through the same contracts and relayer the app uses (`SEED=0` to skip). It also deploys
`MediaStore` and lets the relayer pay for images (`scripts/deploy-media-store.ts`). The seed refuses any chain
but the local one: fake people don't belong on a public network. Restart `pnpm indexer` after restarting the chain.
Without `DATABASE_URL`, likes live in the web server's memory and go away when it restarts.

To sign in, use a browser wallet with the local network added: RPC `http://127.0.0.1:8545`, chain 31337. Any address
works, it needs no MON: signing up and posting are sponsored.

## Tests

```sh
pnpm typecheck
pnpm test                                     # unit tests
pnpm test:e2e                                 # protocol flow against the local chain
pnpm --filter @lens-monad/indexer test:e2e    # the indexer's API (chain and indexer running)
pnpm --filter @lens-monad/web test:e2e        # the app's server end to end (chain, indexer and web running)
node apps/web/test/ui/walkthrough.mjs         # the UI in Chromium: sign up, post, reply, an image, follow, dark mode, mobile
node apps/web/test/ui/passkey.mjs             # passkey accounts, with Chrome's virtual authenticator
```

CI (`.github/workflows/ci.yml`) runs all of these but the UI scripts on every pull request and push to `main`: the
unit tests against a Postgres service, so the shared implementations' tests run too, a check that MediaStore's
committed artifact is what its source builds to, and the end-to-end suites against `pnpm chain`, the indexer and the
app.

The web end-to-end tests read `/api/health`'s details, so run them with the server's `HEALTH_TOKEN` set. The UI
walkthrough needs `playwright-core` and a Chromium (`PLAYWRIGHT_CORE`, `CHROMIUM_PATH`), and saves screenshots
to `SHOTS_DIR`. It signs in with a test wallet it injects into the page, a fresh key each run, and reads the chain at
`RPC_URL`.

## Deploying to testnet or mainnet

For the deployed Monad testnet contracts, use the [testnet handoff](docs/monad-testnet.md): the addresses are already
included, the contracts are activated, and relayers can be configured later. Run `pnpm check:testnet` for a read-only
deployment check.

Parallax runs as a Next.js app on Vercel (the pages and the relayer's API), and the indexer and Postgres on Railway.

1. **Address book.** Deploy the protocol (`lens-monad-protocol` README), then `LENS_CONTRACTS_DIR=… pnpm sync:contracts`:
   it copies `deployments/<chainId>.json` into `packages/protocol/deployments` and regenerates
   `packages/protocol/src/address-books.ts`, which every package imports. With only the JSON at hand, drop it in
   `packages/protocol/deployments` and run `pnpm sync:contracts --address-books`. Commit both files.
2. **Relayers.** Two or more keys, allowlisted on the SponsorRouter and funded with MON: see
   [Relayers and sponsorship](#relayers-and-sponsorship).
3. **Railway.** A Postgres service, and the indexer (`apps/indexer`: its `railway.json`, and its `.env.example` for
   `PONDER_CHAIN_ID`, `PONDER_RPC_URL`, `PONDER_GET_LOGS_RANGE` and `DATABASE_URL`). Give the indexer a public domain:
   it's the app's `INDEXER_URL`. The app keeps its own tables (relayer nonces, rate limits, the gas budget, and likes, which are
   Parallax's own and off-chain) in the `lens_web` schema of the same database.
4. **Images.** `RPC_URL=… DEPLOYER_PRIVATE_KEY=… pnpm deploy:media-store` deploys `MediaStore` (any funded key: it
   isn't owned), then add the chain and the block it prints to `MEDIA_STORE_DEPLOYMENTS` in
   `packages/protocol/src/media.ts`. For relayers to pay for images, the Safe calls the `setFunction` the script
   prints on the `SponsorRouter`; until then, image chunks answer 403 and users pay from their wallets. Changing the
   contract changes its address: `pnpm build:contracts` (Foundry) regenerates `media-store-artifact.ts`.
5. **Vercel**, with the settings and variables below. Then check `https://<app>/api/health` answers 200, and point an
   uptime monitor at it.
6. Before the first launch, run the Postgres implementations' tests against a real Postgres (CI or a scratch Railway
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

| Variable                               | Where                              | What                                                                                                                      |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_CHAIN_ID`                 | Vercel                             | `10143` (testnet) or `143`. Read at build time                                                                            |
| `NEXT_PUBLIC_RPC_URL`                  | Vercel                             | The RPC browsers use. Public: no unrestricted API key                                                                     |
| `NEXT_PUBLIC_APP_URL`                  | Vercel, Production only            | The app's public URL: sign-in messages must name its host. Read at build time                                             |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Vercel                             | A Reown project ID: adds WalletConnect to sign-in, for phones. Allowlist the app's domains in Reown. Read at build time   |
| `NEXT_PUBLIC_PASSKEYS`                 | Vercel                             | `false` hides the passkey sign-in (Passkeys, above). On by default. Read at build time                                    |
| `RPC_URL`                              | Vercel, sensitive                  | The server's RPC, e.g. a paid one. The public testnet RPC rate-limits per IP, which Vercel shares                         |
| `INDEXER_URL`                          | Vercel, for builds too             | The indexer's public URL. The `/indexer` proxy is compiled in: changing it takes a redeploy                               |
| `RELAYER_PRIVATE_KEYS`                 | Vercel, sensitive, Production only | Comma-separated relayer keys (`RELAYER_PRIVATE_KEY` for a single one)                                                     |
| `SESSION_SECRET`                       | Vercel, sensitive                  | 32+ random characters (`openssl rand -hex 32`)                                                                            |
| `DATABASE_URL`                         | Vercel, sensitive                  | Railway Postgres's `DATABASE_PUBLIC_URL` + `?sslmode=require`. Required: without it, sponsoring answers 503               |
| `DATABASE_POOL_SIZE`                   | Vercel                             | Connections per instance (5), and 1 per relayer. Instances × (size + relayers) must fit `max_connections` (Railway: 100)  |
| `SPONSOR_GAS_BUDGET_PER_HOUR`          | Vercel                             | Gas all relayers may spend per hour, e.g. `500000000` (~51 MON at 102 gwei). Required: without it, sponsoring answers 503 |
| `SPONSOR_MAX_GAS_PER_TX`               | Vercel                             | Highest gas limit one sponsored action may have (1500000). Over it: 400, the user can pay instead                         |
| `SPONSOR_MAX_GAS_PER_SIGNUP`           | Vercel                             | The same for a sponsored sign-up (3000000)                                                                                |
| `SPONSOR_MAX_GAS_PER_IMAGE_POST`       | Vercel                             | The same for a post with an image (2500000), whose metadata is bigger                                                     |
| `SPONSOR_MAX_GAS_PER_MEDIA_CHUNK`      | Vercel                             | The same for a 64 KB chunk of an image (3200000)                                                                          |
| `SPONSOR_MEDIA_CHUNKS_PER_DAY`         | Vercel                             | Sponsored image chunks per Account per 24 hours (20: 10 to 20 images)                                                     |
| `DISPLAY_FONT_URL`                     | Vercel, build                      | URL of the titles' font file, which isn't in this repo; the build downloads it. Unset: titles use Inter                   |
| `RELAY_PAUSED`                         | Vercel                             | `true` turns sponsored actions off (503). Takes a redeploy                                                                |
| `RELAY_RATE_LIMIT_PER_MINUTE`          | Vercel                             | Sponsored actions per Account per minute (30)                                                                             |
| `SIGNUP_RATE_LIMIT_PER_HOUR`           | Vercel                             | Sign-ups per owner per hour (3)                                                                                           |
| `SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR`    | Vercel                             | Sign-ups per IP (IPv6: per /64) per hour (10)                                                                             |
| `SPONSOR_SIGNUPS_PER_HOUR`             | Vercel                             | Sign-ups in all per hour (200)                                                                                            |
| `LIKE_RATE_LIMIT_PER_MINUTE`           | Vercel                             | Likes and unlikes per Account per minute (60)                                                                             |
| `RELAYER_MIN_BALANCE_MON`              | Vercel                             | `/api/health` turns 503 when a relayer has less MON (5)                                                                   |
| `INDEXER_MAX_LAG_BLOCKS`               | Vercel                             | ... or when the indexer is more blocks behind (50)                                                                        |
| `HEALTH_TOKEN`                         | Vercel, sensitive                  | Bearer token that shows `/api/health`'s details. Unset: only the status                                                   |
| `PONDER_*`, `DATABASE_URL`             | Railway (indexer)                  | See `apps/indexer/.env.example`                                                                                           |
| `MEDIA_BLOCKLIST`                      | Railway (indexer)                  | Image ids `/media` refuses (451), comma-separated: takedowns. The bytes stay on-chain; the app stops serving them         |

Scope the relayer keys and `DATABASE_URL` to Production. A preview deployment runs a branch's code: give previews
their own relayer and database, or none.

**Operating it.** `GET /api/health` answers `{"status":"ok"}` (200) or `"degraded"` (503). With
`Authorization: Bearer <HEALTH_TOKEN>` it also reports the chain, the head, each relayer's balance and allowlisting,
the indexer's lag, the database, the gas used this hour and whether relaying is paused, and lists the problems; it
never returns keys or URLs. To stop sponsoring, set `RELAY_PAUSED=true` and redeploy; to stop a relayer at once, the Safe
calls `setRelayer(relayer, false)` (its Accounts get a 503 until the key is removed or allowed again).

## Relayers and sponsorship

Three things have to agree for a sponsored action to go through:

- **The SponsorRouter** (onchain, owned by the Safe) lists the relayer EOAs that may call it (`setRelayer`) and the
  functions it may call for an Account (`setFunction`). `DeployLaunch` sets both: the relayers from `RELAYERS`, and the
  functions from `script/SponsoredFunctions.sol` (posting, editing and deleting, following, usernames, blocking).
- **The Account** has the router as an account manager, allowed to execute transactions and set metadata, never to
  move funds. Sign-ups through Parallax add it. An Account made elsewhere gets it from Settings → "Let Parallax pay",
  which the user's wallet sends (`addAccountManager`) and pays for once. Users can revoke it any time.
- **The app** holds the relayer keys, and narrows what it relays to what its client sends (`sponsor.ts`): posts
  without rules, deletes, follows, blocks, profile edits, and chunks of images within the app's 120 KB. Sign-ups don't go through the router: the relayer calls
  `LensFactory.createAccountWithUsernameFree` itself.

Until the Safe runs `ActivateLaunch` (`lens-monad-protocol`), the launch's gates keep everyone but the Safe from
creating usernames, posting and following, so sign-ups and posts fail even with the relayers set up.

### Setting up a deployment

1. **Create the keys**, two or more (each sends a few transactions per second, see Architecture): `cast wallet new`.
   Use plain EOAs that send nothing else. Don't delegate them with EIP-7702: Monad's
   [reserve balance](https://docs.monad.xyz/developer-essentials/reserve-balance) rules are stricter for delegated
   accounts.
2. **Allowlist them on the router.** On a new deployment, pass them to `DeployLaunch`:
   `RELAYERS=0xRelayer1,0xRelayer2 forge script script/DeployLaunch.s.sol …`. On an existing one, the Safe calls
   `setRelayer(relayer, true)` on the `SponsorRouter`, whose address is in
   `packages/protocol/deployments/<chainId>.json`. Check each one:

   ```sh
   cast call <SponsorRouter> "isRelayer(address)(bool)" <relayer> --rpc-url <rpc>
   ```

3. **Fund them.** The hourly budget bounds what they spend together: `SPONSOR_GAS_BUDGET_PER_HOUR` × the gas price,
   e.g. 500M gas ≈ 51 MON an hour at 102 gwei. A sign-up's gas limit is ~2.4M (~0.24 MON), a post's ~0.8M (~0.09 MON),
   and Monad charges the limit ([gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing)). Keep each
   relayer at 10 MON or more, its reserve balance (Before production). Monad's consensus checks a sender's gas against
   its balance from 3 blocks back, so a key's first transaction only goes in a few blocks after the transfer that
   funded it.
4. **Configure the app** (Vercel, Production only): `RELAYER_PRIVATE_KEYS` comma-separated, `DATABASE_URL`, and
   `SPONSOR_GAS_BUDGET_PER_HOUR`; without the last two, sponsored actions answer 503. The order of the keys decides
   which relayer serves which Account. The gas caps, rate limits and `RELAYER_MIN_BALANCE_MON` have defaults (see the
   table above), and `HEALTH_TOKEN` unlocks the checks in the next step.
5. **Check it.** `/api/health` with the token lists each relayer, whether the router allowlists it, and its balance:

   ```sh
   curl -H "Authorization: Bearer $HEALTH_TOKEN" https://<app>/api/health
   ```

   Then sign up from a fresh wallet with no MON, and post.

### Changing relayers

- **Adding one.** Allowlist and fund it first, then add its key to `RELAYER_PRIVATE_KEYS` and redeploy. Most Accounts
  move to another relayer, which is harmless between actions. A key the router doesn't allowlist answers 503 for its
  Accounts.
- **Removing one, or a leaked key.** The Safe calls `setRelayer(relayer, false)`, which stops it at once (its Accounts
  get a 503), then the key comes out of `RELAYER_PRIVATE_KEYS` with a redeploy. To sweep its MON afterwards: Monad lets
  a transfer take an account below 10 MON only when it sent nothing in the 3 blocks before, so send one transfer once
  the relayer is idle.
- **Pausing all of them.** `RELAY_PAUSED=true` and a redeploy (Operating it). Users can still pay from their wallets.

### Locally

`pnpm chain` allowlists anvil's account #3, the app's default relayer, so one relayer works with no setup. The
concurrency end-to-end test needs two. After `pnpm chain`, allowlist anvil's #4 as the Safe (anvil's #0, which the node
signs for):

```sh
cast send 0x19D9cef382F54eEd84F5028d03497C7d07E1e61E "setRelayer(address,bool)" \
  0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 true \
  --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --unlocked --rpc-url http://127.0.0.1:8545
```

and give the app both keys in `apps/web/.env.local`:

```sh
RELAYER_PRIVATE_KEYS=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6,0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
```

## Before production

- **Relayer spend.** The relayer only sends the calls the app makes (posts without rules, deletes, follows, blocks),
  each under a gas cap, within rate limits, an hourly gas budget and an hourly sign-up cap shared by every instance.
  EOAs are free and IPs cheap, so the budget is what bounds spend, and someone can use up the sign-up cap on purpose:
  sign-ups still need a check (captcha, or proof of personhood). Replies, quotes and follows still run the rules
  already on the target post or account; the gas cap bounds those.
- **Gas accounting.** The budget counts the receipts' `gasUsed`. Monad charges the gas limit (estimate + 10%): if its
  receipts report the gas used, the budget undercounts the MON spent by up to 10%.
- **Relayer throughput.** Each key sends a few transactions per second (Architecture), so the number of keys sets the
  ceiling. The figures are estimates: load-test on testnet (many Accounts posting at once per key) before picking how
  many keys to run. Moving the chain's nonce read out of the lock would raise it further.
- **Stuck transactions.** A transaction the node keeps but doesn't include holds up every later one from its relayer
  (1/N of Accounts) until the 30s stall recovery: those actions answer 504 and may still go in later.
- **Relayer balances.** Consensus on Monad runs ahead of execution, so it only includes a sender's transaction while
  the gas of its transactions from the last 3 blocks (~1.2s) stays under its
  [reserve balance](https://docs.monad.xyz/developer-essentials/reserve-balance): 10 MON, or the sender's balance if
  lower. At ~102 gwei, an action costs at most ~0.15 MON (a sign-up ~0.31, a 64 KB image chunk ~0.3), so a relayer at
  10 MON or more can have 30+ actions in flight per 1.2s, above what one key sends, and one at `RELAYER_MIN_BALANCE_MON` (5) half that. It
  only limits a relayer that's nearly empty, whose transactions are then left out and stall like a stuck one: keep
  relayers funded, and alert on `/api/health`.
- **Lost broadcasts.** If the RPC accepts a transaction but its answer is lost (a timeout), the action is reported as
  failed though it may still go in, and a retry can duplicate it.
- **Pausing isn't instant.** `RELAY_PAUSED` takes a redeploy on Vercel (about a minute); `setRelayer(…, false)` from
  the Safe is immediate.
- **Source stamps.** Posts don't carry the reference App's source stamp yet, so they aren't attributed to an app.
- **Images are permanent.** Whatever is uploaded stays in the chain's history for good: deleting the post hides it,
  but the bytes remain. `MEDIA_BLOCKLIST` is the only way to stop serving one, so have a takedown process (and a
  route for illegal content reports) before opening images to everyone.
- **Image storage.** The indexer's Postgres holds every image (up to 1 MB each, `MAX_MEDIA_BYTES`; the app posts 120
  KB). Rebuilding it reindexes the logs, so the RPC must serve old blocks' logs: Monad full nodes keep all
  transactional history, older data on an archive the RPC provider runs
  ([historical data](https://docs.monad.xyz/developer-essentials/historical-data)). Check your provider's.
- **Finality.** The app shows the result once the indexer saw the block. Monad's `latest` is a proposed block: anything
  that moves value should wait for `finalized`.
