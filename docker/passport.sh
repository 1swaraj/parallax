#!/usr/bin/env bash
# The passport service in compose.yaml (profile "passport"): Community Passport, with this app registered as a club.
#
# First start on a chain: deploys the Passport's grant registry and this app's ClubForwarder, and writes the
# Passport's configuration (docker/passport-config.ts). Every start: prints what to enter in Admin → Community
# Passport, then runs the Passport. Its sign-in codes go to this service's log.
#
# Runs in the passport image (the Passport at /passport), with the repository at /app and its workspace installed.
set -euo pipefail

STATE_DIR=${STATE_DIR:-/state}
RPC=http://127.0.0.1:8545
# anvil's first test account, from its public test phrase: local only.
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# The app's relayer on chain 31337 (LOCAL_RELAYER_KEY in env.ts): the forwarder's only relayer.
RELAYER=0x90F79bf6EB2c4f870365E785982E1f101E93b906

# A registry missing from the chain means the chain is new: what the Passport stored belongs to the old one.
if [ ! -f "$STATE_DIR/registry" ] || [ "$(cast codesize "$(cat "$STATE_DIR/registry")" --rpc-url "$RPC")" = 0 ]; then
  rm -rf "${STATE_DIR:?}"/*
  echo "Deploying the grant registry and this app's ClubForwarder..."
  (
    cd /passport/contracts
    PASSPORT_ADMIN=$DEPLOYER PASSPORT_GUARDIAN=$DEPLOYER PASSPORT_UPGRADE_DELAY=0 \
      forge script script/Deploy.s.sol --skip test --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  )
  registry=$(jq -r '.returns.registry.value' /passport/contracts/broadcast/Deploy.s.sol/31337/run-latest.json)
  forwarder=$(
    cd /app
    NEXT_PUBLIC_CHAIN_ID=31337 RPC_URL=$RPC PASSPORT_GRANT_REGISTRY=$registry INSTANCE_RELAYER_ADDRESSES=$RELAYER \
      INSTANCE_DEPLOYER_PRIVATE_KEY=$DEPLOYER_KEY node --import tsx scripts/instance-deploy-forwarder.ts |
      sed -n 's/^CLUB_FORWARDER_ADDRESS=//p'
  )
  [ -n "$forwarder" ] || { echo "The forwarder wasn't deployed." >&2; exit 1; }
  (cd /app && STATE_DIR=$STATE_DIR REGISTRY=$registry FORWARDER=$forwarder node --import tsx docker/passport-config.ts)
  # Last: its presence means everything above is done.
  echo "$registry" >"$STATE_DIR/registry"
fi

echo
cat "$STATE_DIR/admin.txt"
echo
set -a
# shellcheck disable=SC1091
. "$STATE_DIR/passport.env"
set +a
cd /passport
exec node apps/passport/src/main.ts
