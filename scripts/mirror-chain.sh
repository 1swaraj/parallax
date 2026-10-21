#!/usr/bin/env bash
# Starts a local Monad node with a read-only mirror of Lens Chain, for mirror mode (README, Mirror mode): Lens deployed
# in migration mode from the contracts repository (DeployMonad then DeployLaunch with MIGRATION_MODE=true, which install
# the importers behind the canonical proxies, and are never sealed), then a small made-up slice of Lens Chain imported
# through the importers, as the migrator imports the real one (scripts/mirror-seed.ts, MIRROR_SEED=0 to skip). Syncs
# the importers' ABIs and the mirror's address book into packages/protocol (deployments/mirror/31337.json).
#
# Needs Foundry 1.8.0 or later, and LENS_CONTRACTS_DIR pointing at a built checkout of lens-monad-protocol with the
# importers (PR #8, feat/migration-cutover, or later). It writes its address books and forge's broadcasts there. The
# node takes chain 31337 and port 8545, like `pnpm chain`: run one at a time.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONTRACTS=$(cd "${LENS_CONTRACTS_DIR:-$ROOT/../lens-monad-protocol}" && pwd)
RPC=http://127.0.0.1:8545
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# The importers' operator, which scripts/mirror-seed.ts imports as: anvil's 7th account, which the node signs for.
OPERATOR=0x976EA74026E726554dB657fA54763abd0C3a0aa9

if [ ! -f "$CONTRACTS/contracts/monad-migration/MigrationAccountDeployer.sol" ]; then
  echo "$CONTRACTS has no importers (contracts/monad-migration): check out lens-monad-protocol's PR #8 or later." >&2
  exit 1
fi
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Something is already listening on $RPC. Stop it first, the deployment expects a fresh node." >&2
  exit 1
fi

anvil --network monad --auto-impersonate --enable-tx-gas-limit --port 8545 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null' EXIT INT TERM

until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.2; done

(
  cd "$CONTRACTS"
  export MIGRATION_MODE=true
  MIGRATION_SESSION=$(cast keccak "parallax.local-mirror")
  export MIGRATION_SESSION
  export MIGRATION_OPERATOR=$OPERATOR
  export ADDRESS_BOOK=deployments/31337.json
  # This node is fresh. Discard the previous local run's book before promoting its replacement.
  rm -f "$ADDRESS_BOOK" "$ADDRESS_BOOK.pending"
  forge script script/DeployMonad.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
  forge script script/DeployLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
)

LENS_CONTRACTS_DIR="$CONTRACTS" node "$ROOT/scripts/sync-contracts.mjs" --mirror
# The node is new, so whatever the indexer stored is from another chain: start over (restart the indexer).
rm -rf "$ROOT/apps/indexer/.ponder"

if [ "${MIRROR_SEED:-1}" = "1" ]; then
  (cd "$ROOT" && node --import tsx scripts/mirror-seed.ts)
fi
echo "The mirror is deployed on $RPC (chain 31337). Ctrl-C to stop the node."
wait $ANVIL_PID
