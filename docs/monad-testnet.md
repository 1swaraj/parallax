# Monad testnet deployment

This PR connects Parallax to a fresh Lens deployment on chain **10143**. No migration, historical accounts,
username import, or reservations are involved. The Feed, Graph and `lens` Namespace are activated.
Usernames use the normal charset rules and minimum length of four; the protocol treasury fee is zero.

The complete address book is [`10143.json`](../packages/protocol/deployments/10143.json). Both the web app and
Ponder select it automatically from their chain ID; Ponder also reads its `deploymentBlock` as the starting block.
[`10143-release.json`](../packages/protocol/deployments/10143-release.json) records the source revision, deployment
transactions, compiler settings, ownership and client contract code hashes. No addresses need to be pasted into code.

## What Parallax needs to do

1. Merge this PR and install with `pnpm install --frozen-lockfile`. Run `pnpm check:testnet` to check the public
   deployment without sending transactions. A provider URL can be supplied with `RPC_URL`.
2. Deploy **Postgres and `apps/indexer`** using the existing Railway configuration. Set `PONDER_CHAIN_ID=10143`,
   `PONDER_RPC_URL` to your HTTP RPC, `PONDER_GET_LOGS_RANGE=100` for the public RPC, and `DATABASE_URL` to Postgres.
   Keep a single indexer writer per schema. Wait for its `/ready` endpoint to return 200; retain its public URL.
3. Deploy **`apps/web`** using the existing Vercel instructions in the README. Use
   [`apps/web/.env.monad-testnet.example`](../apps/web/.env.monad-testnet.example) as the testnet settings template.
   Fill in `NEXT_PUBLIC_APP_URL`, `INDEXER_URL`, a random `SESSION_SECRET` of at least 32 characters,
   `HEALTH_TOKEN`, and `DATABASE_URL` (the public TLS Postgres connection). Set these before building:
   `NEXT_PUBLIC_CHAIN_ID=10143`, the browser RPC URL, and `INDEXER_URL` are baked into the client/proxy configuration.
   A server RPC can be provided separately through `RPC_URL`. Use provider endpoints with sufficient capacity
   for the indexer and server; the public endpoint is suitable for initial checks.
4. Initially keep **`RELAY_PAUSED=true`** and leave relayer keys unset. There are **no active relayers** at handoff.
   Users can fund their own test wallets and select **Pay from my wallet (MON)** during signup. That choice also
   applies to later actions and can be changed in Settings. The web health endpoint
   currently reports degraded/503 when relayer keys or sponsorship settings are missing, even while deliberately
   paused; inspect its authenticated details and the indexer's `/ready` instead of treating that as a contract failure.
5. When sponsorship is wanted, create a dedicated relayer wallet, provide its **public address** to the contract
   owner for allowlisting, fund it with testnet MON, and put its private key only in the web service's
   `RELAYER_PRIVATE_KEYS`. Set `SPONSOR_GAS_BUDGET_PER_HOUR` and retain shared Postgres, then set
   `RELAY_PAUSED=false` and redeploy. One relayer is enough for the first trial. Do not use either deployment key
   as a service key. No relayer has been funded as part of this handoff.
6. Smoke test signup, post/reply, follow, profile edit, and indexed reads. Use wallet-paid mode initially;
   repeat with sponsored actions after completing step 5. Run the repository's Postgres tests against a scratch
   database before enabling sponsorship across server instances.

The client already includes the current eight ABIs. This PR fixes the remaining profile route mismatch:
`SponsorRouter.setMetadataURI(account, metadataURI, sourceStamp)` needs the empty source stamp. The signup form now
offers wallet-paid mode before an account exists. The PR also updates
the local chain helper to promote the address book after each successful deployment stage.

## Ownership and later administration

- System owner, namespace admin, treasury and owner of the proxy administration helper:
  `0xa01ab5BC6c3e39BfAEE63efdFba29555F5453A4c`.
- LensCreate2 bootstrap wallet: `0xE85Bc2358DAC48db42Fe381490034d543E8c53dc`; its nonce-zero deployment is
  `0xc64b13C94FA90F462986Ce4E4C0e6aE522C69392`. It received the requested 1 MON for bootstrapping.
- OpenZeppelin ProxyAdmin: `0xD3fD0d733E5CaD20E61Ce967C328C39cC693346B`, owned directly by the system owner.
  This helper manages transparent proxies and is not a multisig.

The scripts/address book retain the historical name `SAFE` / `Safe`; its value is the owner EOA above.
No Safe or multisig was deployed. The launch script requires a nonempty relayer list, so the bootstrap wallet
was temporarily listed and then removed before handoff. The final router list is empty.

To enable a future relayer, the owner sends `setRelayer(address,bool)` with the new address and `true`
to `SponsorRouter`. For example, using an owner-controlled Foundry keystore:

```sh
cast send <SponsorRouter address from 10143.json> 'setRelayer(address,bool)' <new-relayer-address> true \
  --rpc-url https://testnet-rpc.monad.xyz --account <owner-keystore>
```

Parallax does not need the deployment keys, migration tooling, a separate Lens API, or a separate media service
for this text/data-URI MVP. This PR does not deploy its web app, indexer or database.

## Post images

Parallax's `MediaStore` (see Images in the README) is deployed on testnet at
`0xf05e400a8a96C40C61f011504394365A1d98FE87`, block 72,383,356, and listed in `MEDIA_STORE_DEPLOYMENTS`. Until the
owner lets relayers pay for it, images are paid from the author's wallet:

```sh
cast send 0xE7da6c231A7fE4fCBDd9915e244AE08D75C51009 'setFunction(address,bytes4,bool)' \
  0xf05e400a8a96C40C61f011504394365A1d98FE87 0x37e2a8ef true \
  --rpc-url https://testnet-rpc.monad.xyz --account <owner-keystore>
```

## Source provenance and future explorer verification

The deployed source is protocol PR #4 at `02da644aebe224a3614fab2cdb4e1162c9d4a9c0`, with only the two
LensCreate2 deployment constants and their comment changed for the bootstrap wallet above. The patch is retained
with the release metadata. The owner configuration selects normal mode (`MIGRATION_MODE=false`).

**Explorer source verification is deliberately deferred.** The deployment operator retains a verification archive
containing exact source/compiler inputs, artifacts, constructor arguments, public configuration and broadcast
receipts. No verification request was submitted. Source verification does not change addresses or block client
integration. Coordinate that later with the deployment operator; do not redeploy the contracts.
