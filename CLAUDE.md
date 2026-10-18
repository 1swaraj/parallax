# Working on Parallax

## Monad claims are checked against Monad's docs

Any claim about how Monad behaves (gas and fees, reserve balance, mempool and nonces, RPC methods and block tags,
block times, finality, limits) is checked against [docs.monad.xyz](https://docs.monad.xyz) before it goes into code,
comments, the README, or an answer. Don't rely on memory or on Ethereum behaviour: Monad differs in places that matter
to the relayer. Link the page that backs a claim in the README, and say plainly when the docs don't cover something or
contradict themselves, rather than guessing.

Pages that come up most:

- [Gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing): charged on the gas limit, base fee floor
- [Reserve balance](https://docs.monad.xyz/developer-essentials/reserve-balance): in-flight gas per sender
- [RPC differences](https://docs.monad.xyz/reference/rpc-differences): `pending` is `latest`, nonce gaps are accepted
- [Differences from Ethereum](https://docs.monad.xyz/developer-essentials/differences)
