#!/usr/bin/env bash
# The web service in compose.yaml: the app's dev server, as a managed instance.
#
# INSTANCE_SECRET encrypts the stored secrets and, without SESSION_SECRET, signs sessions: it's generated on this
# machine the first time and kept in a volume, like the database it goes with, rather than written in compose.yaml.
# SETUP_TOKEN stays unset, so the app prints a one-time token when it first sets up the database.
set -euo pipefail

SECRET_FILE=${SECRET_FILE:-/secrets/instance-secret}
if [ ! -s "$SECRET_FILE" ]; then
  mkdir -p "$(dirname "$SECRET_FILE")"
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' >"$SECRET_FILE"
fi
INSTANCE_SECRET=$(cat "$SECRET_FILE")
export INSTANCE_SECRET
# Next itself, not through pnpm, so it gets Docker's SIGTERM and stops cleanly. No --hostname: it already listens on
# every interface, and it builds request URLs from that flag, which would put 0.0.0.0 in the Passport's redirect URI.
cd apps/web
exec node_modules/.bin/next dev --port 3000
