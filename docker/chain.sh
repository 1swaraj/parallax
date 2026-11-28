#!/usr/bin/env bash
# The chain service in compose.yaml: a local Monad node with Lens deployed and seeded, kept in the chain volume.
#
# First start: deploys Lens from the image's checkout, then MediaStore and the seed data, as `pnpm chain` does
# (scripts/dev-chain.sh), and saves the node's state. Later starts load that state, so the app's database and the
# indexer stay in step with the chain. `docker compose down -v` starts everything over.
#
# Needs Foundry 1.8.0 or later, LENS_CONTRACTS_DIR (default /lens) at the revision packages/protocol/deployments/31337.json
# comes from, built, and the workspace installed. Run from the repository root.
set -euo pipefail

STATE_DIR=${STATE_DIR:-/state}
LENS=${LENS_CONTRACTS_DIR:-/lens}
PONDER_DIR=${PONDER_DIR:-apps/indexer/.ponder}
RPC=http://127.0.0.1:8545
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
STATE=$STATE_DIR/chain.json
# Written once the first start has deployed and seeded everything: a state saved before that is incomplete.
DEPLOYED=$STATE_DIR/deployed
# The address book the chain was deployed for, to compare with the repository's on later starts.
BOOK=packages/protocol/deployments/31337.json
SAVED_BOOK=$STATE_DIR/31337.json
RESET='Run `docker compose down -v` to start over with a new chain.'
# The service's healthcheck: the chain is deployed or loaded, and serving.
READY=${READY_FILE:-/tmp/chain-ready}

mkdir -p "$STATE_DIR"
rm -f "$READY"

# The state is saved every 5 seconds and when the node stops, so a restart loses at most a few seconds of it.
ANVIL=(anvil --network monad --auto-impersonate --enable-tx-gas-limit --host 0.0.0.0 --port 8545 --silent
  --dump-state "$STATE" --state-interval 5)
start() {
  "${ANVIL[@]}" "$@" &
  ANVIL_PID=$!
  # Stop the node with this script, failed or stopped: Docker sends SIGTERM, and anvil saves the state on its way out.
  trap 'kill -TERM $ANVIL_PID 2>/dev/null; wait $ANVIL_PID' EXIT
  trap 'exit 143' TERM INT
  until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do
    # Otherwise a node that can't start (a state it can't read) leaves this waiting until the healthcheck gives up.
    kill -0 "$ANVIL_PID" 2>/dev/null || {
      echo "anvil exited before serving. $RESET" >&2
      exit 1
    }
    sleep 0.2
  done
}

if [ -f "$DEPLOYED" ] && [ -f "$STATE" ]; then
  # The repository moved to another Lens deployment since (a pull, another branch): its addresses aren't on this chain.
  if ! cmp -s "$SAVED_BOOK" "$BOOK"; then
    echo "$BOOK changed since this chain was deployed. $RESET" >&2
    exit 1
  fi
  start --load-state "$STATE"
  # A loaded node's clock resumes from when it was saved: bring it to the wall clock, or new posts look old.
  now=$(date +%s)
  if [ "$(cast block latest -f timestamp --rpc-url "$RPC")" -lt "$now" ]; then
    cast rpc --rpc-url "$RPC" anvil_setNextBlockTimestamp "$now" >/dev/null
    cast rpc --rpc-url "$RPC" evm_mine >/dev/null
  fi
  echo "Loaded the chain from $STATE, at block $(cast block-number --rpc-url "$RPC")."
else
  rm -f "$STATE" "$DEPLOYED" "$SAVED_BOOK"
  # The clock starts 5 days back, so the seed can spread its posts over the last few days; seeding (or SEED=0) then
  # brings it back to the wall clock.
  start --timestamp $(($(date +%s) - 5 * 86400))
  echo "Deploying Lens to a new chain. This takes a few minutes..."
  (
    cd "$LENS"
    export MIGRATION_MODE=false
    export ADDRESS_BOOK=deployments/31337.json
    rm -f "$ADDRESS_BOOK" "$ADDRESS_BOOK.pending"
    forge script script/DeployMonad.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
    forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
    forge script script/DeployLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
    forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
    forge script script/ActivateLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  )
  # The app reads the committed address book. dev-chain.sh copies the new one over it; here a difference means the
  # image's Lens isn't the revision this repository was built against, so stop rather than change tracked files.
  if ! cmp -s "$LENS/deployments/31337.json" "$BOOK"; then
    echo "Lens deployed to different addresses than $BOOK." >&2
    echo "Rebuild the chain image at the revision in docker/Dockerfile (LENS_REVISION)." >&2
    exit 1
  fi
  cp "$BOOK" "$SAVED_BOOK"
  node --import tsx scripts/deploy-media-store.ts
  # What the indexer stored is from another chain: start over.
  rm -rf "${PONDER_DIR:?}"/*
  if [ "${SEED:-1}" = "1" ]; then
    node --import tsx scripts/seed.ts
  else
    cast rpc --rpc-url "$RPC" anvil_setNextBlockTimestamp "$(date +%s)" >/dev/null
    cast rpc --rpc-url "$RPC" evm_mine >/dev/null
  fi
  # Wait for the next save, so the state on disk has everything, then mark it complete.
  sleep 6
  touch "$DEPLOYED"
  echo "Lens is deployed and seeded."
fi

touch "$READY"
echo "Chain 31337 is ready on $RPC."
wait $ANVIL_PID
