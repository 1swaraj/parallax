# The images compose.yaml runs the stack with. Built from this directory: the repository is mounted into the
# containers, not copied.
#
#   dev       Node 24, pnpm and Foundry: installs the workspace and runs the web app and the indexer.
#   chain     dev, with lens-monad-protocol built at the revision packages/protocol/deployments/31337.json comes from.
#             The repository is private: the build reads a GitHub token from the github_token secret.
#   passport  Community Passport at a pinned commit, with the onboarding patch, on the Node 26 it requires.

# Foundry's release binaries, checked against the checksums published with them.
FROM debian:trixie-slim AS foundry
ARG TARGETARCH
ARG FOUNDRY_VERSION=v1.8.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sum=58850106984038f3a7200f38a4182c8cb423d3a4f4c7848eacbc2453e6bc35fc ;; \
      arm64) sum=ca61f3f6e7d635f34e3e174409964d29126fa135794cd84cead8919dd50e0930 ;; \
      *) echo "Foundry publishes no Linux build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/foundry.tar.gz \
      "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_$TARGETARCH.tar.gz"; \
    echo "$sum  /tmp/foundry.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin forge cast anvil

FROM node:24-trixie-slim AS dev
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git jq && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/cast /usr/local/bin/anvil /usr/local/bin/
RUN npm install --global pnpm@10.27.0
WORKDIR /app

FROM dev AS chain
# The reviewed SponsorRouter revision (PR #4), as in the README's "Run it locally".
ARG LENS_REVISION=02da644aebe224a3614fab2cdb4e1162c9d4a9c0
# The token is only in this step's environment: it isn't written to the image or to the checkout's git config.
RUN --mount=type=secret,id=github_token,required=true set -eu; \
    token=$(cat /run/secrets/github_token); \
    if [ -z "$token" ]; then echo 'Set GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token)' >&2; exit 1; fi; \
    git init -q /lens; \
    git -C /lens -c "http.https://github.com/.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 -w0)" \
      fetch -q --depth 1 https://github.com/monad-developers/lens-monad-protocol.git "$LENS_REVISION"; \
    git -C /lens checkout -q FETCH_HEAD; \
    git -C /lens submodule update --init --recursive --depth 1
WORKDIR /lens
RUN npx -y yarn@1.22.22 install --frozen-lockfile --ignore-scripts && forge build
WORKDIR /app

FROM node:26-trixie-slim AS passport
ARG PASSPORT_REVISION=50877aa3db3d9fc08893e3604fde4f303ceaf763
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git jq && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/cast /usr/local/bin/
RUN npm install --global pnpm@12.21.0
RUN git init -q /passport \
    && git -C /passport fetch -q --depth 1 https://github.com/bensprks/community-passport.git "$PASSPORT_REVISION" \
    && git -C /passport checkout -q FETCH_HEAD
WORKDIR /passport
# Username and profile at sign-up, which this app's Passport sign-in expects. Not in the Passport's repository yet.
COPY passport-onboarding.patch /tmp/
RUN git apply /tmp/passport-onboarding.patch
# The registry needs only forge-std and OpenZeppelin. The Lens submodule (private) is for the Passport's integration
# tests: drop it, or forge tries to install it, and build without the tests.
RUN git config -f .gitmodules --remove-section submodule.contracts/lib/lens-monad-protocol \
    && git config -f .gitmodules --remove-section submodule.contracts/lib/openzeppelin-contracts-v4 \
    && git submodule update --init --depth 1 contracts/lib/forge-std contracts/lib/openzeppelin-contracts \
    && cd contracts && forge build --skip test
RUN pnpm install --frozen-lockfile
