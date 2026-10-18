#!/usr/bin/env bash
# Starts a local Monad node and deploys Lens to it from the contracts repository, as its README describes:
# DeployMonad (the protocol), then DeployLaunch (the "lens" Namespace, the App and the SponsorRouter, with anvil's
# 4th account as relayer), then ActivateLaunch (opens the launch's preload gates). Then syncs the ABIs and the address book into packages/protocol.
#
# Needs Foundry 1.8.0 or later (`anvil --network monad`), and LENS_CONTRACTS_DIR pointing at a built checkout of
# lens-monad-protocol (default ../lens-monad-protocol). Addresses are deterministic on a fresh node.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONTRACTS=$(cd "${LENS_CONTRACTS_DIR:-$ROOT/../lens-monad-protocol}" && pwd)
RPC=http://127.0.0.1:8545
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Something is already listening on $RPC. Stop it first, the deployment expects a fresh node." >&2
  exit 1
fi

# The clock starts 5 days back, so the seed can spread its posts over the last few days; seeding (or SEED=0) then
# brings it back to the wall clock.
anvil --network monad --auto-impersonate --enable-tx-gas-limit --port 8545 --silent --timestamp $(($(date +%s) - 5 * 86400)) &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null' EXIT INT TERM

until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.2; done

(
  cd "$CONTRACTS"
  export MIGRATION_MODE=false
  export ADDRESS_BOOK=deployments/31337.json
  # This node is fresh. Discard the previous local run's book before promoting its replacement.
  rm -f "$ADDRESS_BOOK" "$ADDRESS_BOOK.pending"
  forge script script/DeployMonad.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
  forge script script/DeployLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
  # The launch starts closed (the preload gates); locally the deployer is the Safe, so it opens it right away.
  forge script script/ActivateLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
)

LENS_CONTRACTS_DIR="$CONTRACTS" node "$ROOT/scripts/sync-contracts.mjs"
# The node is new, so whatever the indexer stored is from another chain: start over (restart `pnpm indexer`).
rm -rf "$ROOT/apps/indexer/.ponder"

if [ "${SEED:-1}" = "1" ]; then
  (cd "$ROOT" && node --import tsx scripts/seed.ts)
else
  cast rpc --rpc-url "$RPC" anvil_setNextBlockTimestamp "$(date +%s)" >/dev/null
  cast rpc --rpc-url "$RPC" evm_mine >/dev/null
fi
echo "Lens is deployed on $RPC (chain 31337). Ctrl-C to stop the node."
wait $ANVIL_PID
