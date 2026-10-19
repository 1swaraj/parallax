# Self-hosting design

Research on 2026-10-18. No public transaction was sent. All deployments and writes below used anvil
`--network monad`, forking testnet at block 72110000. The private
`monad-developers/lens-monad-protocol` repository is inaccessible to this workspace's GitHub token, so a
source build and `pnpm chain` deployment could not be run. The fork executes the deployed bytecode and
storage; this is stronger evidence for the current release than assuming the upstream source matches.

## Evidence and reproduction

Inputs: the eight [client ABIs](../packages/protocol/src/abis),
[release record](../packages/protocol/deployments/10143-release.json),
[address book](../packages/protocol/deployments/10143.json), and
[source patch](../packages/protocol/deployments/10143-source.patch). The patch changes only LensCreate2
bootstrap constants, not router or Account policy. Public upstream Lens source is supporting context,
not proof of the private fork's behavior.

Read-only testnet checks (`cast` 1.8.5):

```sh
RPC=https://testnet-rpc.monad.xyz
ROUTER=0xE7da6c231A7fE4fCBDd9915e244AE08D75C51009
cast chain-id --rpc-url "$RPC"                            # 10143
cast call "$ROUTER" 'owner()(address)' --rpc-url "$RPC"   # 0xa01ab5BC6c3e39BfAEE63efdFba29555F5453A4c
cast call "$ROUTER" 'getRelayers()(address[])' --rpc-url "$RPC" # []
cast call "$ROUTER" 'getFunctions()((address,bytes4)[])' --rpc-url "$RPC"
cast storage "$ROUTER" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url "$RPC"
cast code 0xeb612aA4EE2634A8695E57D5cd0427054C9D3bF5 --rpc-url "$RPC" | cast keccak
```

The implementation slot is `0xeb612aA4EE2634A8695E57D5cd0427054C9D3bF5`; its runtime code hash is
`0x776bf070365ad51a4e9321c1de566d48dfcdeba8aac098c7e6ea5fb8bf4eb807`.
`getFunctions()` returns ten entries:

| Target              | Selectors                                |
| ------------------- | ---------------------------------------- |
| LensGlobalFeed      | `0x322a74d2`, `0x39d2e298`, `0x8e789fc5` |
| LensGlobalGraph     | `0xcde4e98b`, `0xe05d4b07`               |
| LensGlobalNamespace | `0x1a0e5180`, `0x4df53b27`, `0x666866d3` |
| AccountBlockingRule | `0xe5bb6575`, `0x778eb30b`               |

Monad's [testnet documentation](https://docs.monad.xyz/developer-essentials/testnets) identifies chain 10143. Its [differences documentation](https://docs.monad.xyz/developer-essentials/differences)
recommends Foundry 1.8.0+ with the Monad execution network for local validation. Deployment gas limits
must follow [Monad gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing): charges use
the limit. No assumption about Ethereum gas costs is needed for this design.

## Per-instance SponsorRouter

**Verdict: works. Confidence: high for this release, verified against its bytecode on a local fork.**

An independent fixed proxy can delegate to the deployed SponsorRouter implementation and initialize its
own storage with the operator as owner, its relayers, and the reference router's `getFunctions()`.
Initialization must happen in the creation transaction; a separately initialized public proxy can be
claimed by another sender. Cloning the reference proxy itself would inherit its proxy logic without
its implementation storage and is not the approach to use. The new fixed proxy has no upgrade admin:
the shared proxy's administrator cannot change its implementation pointer.

Local proof: created router `0xc0bf43a4ca27e0976195e6661b099742f10507e5`, initialized with anvil's owner
and relayer, and confirmed `owner()` and refusal to initialize twice. A relayer that is absent from the
shared router created Account `0x9Ab696d9333813530B90188b2f2cd0C78A1c049d` using
`LensFactory.createAccountWithUsernameFree`, passing the new router in `accountManagers` with
`SPONSOR_ROUTER_PERMISSIONS` from [calls.ts](../packages/protocol/src/calls.ts). It then posted and
followed another new Account through the new router. The Feed, Graph and Namespace accepted these
calls without any shared-router administration. The Account, not its manager, is the caller seen by
the primitives. The two-instance e2e suite extends this with a second router, rejection before user
consent, consent via `addAccountManager`, revocation, and separate instance databases.

Tradeoff: users explicitly trust each router as manager, and pay once from their wallet to add another
instance's router. Operators fund and secure their own relayers and router owner. An Account permission
is not limited by the web server: the router's function allowlist remains the onchain boundary. The
client continues to enforce its narrower permitted calls. The fixed proxy uses existing implementation
code; a protocol implementation change needs a new instance router and renewed user consent.

## Per-instance Lens App and source stamps

**Verdict: works with client and indexer changes. Confidence: high for registration and signed stamping,
verified locally; source stamps are not enabled by this PR.**

`LensFactory.deployApp` in the shipped ABI accepts metadata, a verification flag, owner, admins and
`AppInitialProperties` (shared graph/feed/namespace, signers, treasury, paymaster). It does not require
the shared router owner. A local deployment with verification enabled and an operator signer succeeded.
A signed stamp attached to `Feed.createPost` through the instance router succeeded, and replay of that
stamp was refused. The post's source event recorded the new App. No new Feed or Namespace is required.

The [public App](https://github.com/lens-protocol/lens-v3/blob/development/contracts/extensions/primitives/app/App.sol),
[BaseSource](https://github.com/lens-protocol/lens-v3/blob/development/contracts/core/base/BaseSource.sol)
and [SourceStampBased](https://github.com/lens-protocol/lens-v3/blob/development/contracts/core/base/SourceStampBased.sol)
explain the encoding confirmed on the fork:

- Put the ABI-encoded `SourceStamp` in `createPost`'s `customParams` under
  `keccak256("lens.param.sourceStamp")`.
- `source` is the instance App; `originalMsgSender` is the Lens Account; `validator` is the Feed.
- Sign EIP-712 `SourceStamp(address source,address originalMsgSender,address validator,uint256 nonce,uint256 deadline)`
  with domain name `Lens Source`, version `1`, chain ID and verifying contract = App.
- Use an explicitly registered signer, a unique nonce and a short deadline. App ownership alone does
  not make the owner a signer. Enable verification: otherwise anyone can claim that App's source.

Needed: an App registration command, instance App config and encrypted signer, server-side stamping
of accepted calldata, durable nonce allocation, and indexing/display of the source event. Direct
wallet posts need a stamp request or can remain unattributed. The current stamp signs attribution,
not the post text: it must not be presented as proof of content approval. Signed stamps and their
nonce/deadline prevent replay, but a leaked unused stamp can be used by the Account for another post.
These changes are separate from per-instance sponsorship.

## Shared indexer

**Verdict: works with bounded public reads and per-instance sponsorship checks. Confidence: high for
read isolation; capacity depends on the host and must be measured.**

Ponder indexes shared contracts and chain events, not sessions or relayer keys. All REST reads are
public and accept explicit viewer addresses; blocks/following filters are views over public chain
state. This is not private access control. The API bounds pagination, ancestors, replies, search and
trend scans. GraphQL is disabled by default and must remain disabled on a shared public service.

The existing Account `sponsored` field means permission for the address-book router only. It cannot
decide whether an independent instance can pay. The web app must read `canExecuteTransactions` for
its configured router, including after consent and revocation; server-side ownership and permission
checks remain authoritative. The legacy indexer field stays compatible for existing API users.

Likes, like notifications, relayer nonces, spending budgets and request limits live in each web app's
`lens_web` schema. Each operator needs its own database. Likes and counts are intentionally local;
a post is shared but a like on instance A is not a like on B. Sharing the indexer does not share these
tables. Moderation must filter reads in each web instance, never modify the shared indexer globally.

Public hosting needs GET/HEAD CORS without credentials, bounded per-IP request limits, short public
cache headers on successful reads, no caching of errors, and readiness/liveness endpoints. Ponder
0.18.1 already serves `/ready`, `/health`, `/status` and permissive CORS before the user app; their
semantics should be preserved. An app middleware can protect REST queries, but cannot intercept those
built-in endpoints or its OPTIONS preflight responses. Ponder advertises broader preflight methods,
but REST writes are still refused. The edge should block `/metrics`, enforce the overall rate limit, strip client
forwarding headers and supply the trusted IP header. In-process rate limits bound one indexer process,
not a fleet, and don't replace the edge's volumetric protection. Web proxies must preserve trusted
end-user IPs or their users share the web host's bucket. Caching always keys on the full query string,
including the viewer. After observing a confirmed write in `/status`, the browser adds that block
as `_after` to subsequent read URLs so an old cached timeline cannot hide its own write. Never cache
per-session web responses publicly.

Tradeoff: light mode delegates read availability, RPC/indexing costs and traffic visibility to the
indexer host. Short caches reduce database work at the edge while adding a little read delay; the
write-confirmation `/status` polling remains uncached. Full mode keeps a single writer per Ponder
schema and gives the operator control over those costs and availability. No public indexer URL was
provided with this workspace; a reachable operator-published URL is required before a functional
shared-indexer default can be advertised.

## Deploy button evidence

The [Vercel source parameters](https://vercel.com/docs/deploy-button/source) support Marketplace stores
with `integrationSlug=neon`, `productSlug=neon`, `protocol=storage`. The
[Neon Marketplace page](https://vercel.com/marketplace/neon) identifies integration
`oac_3sK3gnG06emjIEVL09jjntDD` and its environment snippet exports `DATABASE_URL` (pooled),
`DATABASE_URL_UNPOOLED`, plus compatibility `POSTGRES_URL` variables. The button requests the Neon
store without a custom variable prefix. The app accepts `DATABASE_URL`, then `POSTGRES_URL` as fallback.
[Environment parameter documentation](https://vercel.com/docs/deploy-button/environment-variables)
requires every `envDefaults` key to appear in `env`; secrets must have no default. Creating a Vercel
project or installing the integration was not tested because this task forbids deployment.
