# The indexer, built from the repository root: it depends on the workspace package @lens-monad/protocol.
#
#   docker build -f apps/indexer/Dockerfile -t lens-monad-indexer .
#   docker run -p 42069:42069 -e PONDER_CHAIN_ID=10143 -e PONDER_RPC_URL=… -e DATABASE_URL=… \
#     -e DATABASE_SCHEMA=lens lens-monad-indexer
#
# Railway: leave the service's root directory at the repository root, set its config file path to
# /apps/indexer/railway.json (build, start command with a schema per deployment, /ready healthcheck), add a Postgres
# database, and set the variables of .env.example, DATABASE_URL as a reference to the database's.

FROM node:24-slim

RUN npm install --global pnpm@10.27.0

WORKDIR /app

# Manifests first, so the dependencies layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY packages/protocol/package.json packages/protocol/
# All of the indexer's dependencies, dev ones included: @lens-monad/protocol gets viem, its peer dependency, from them.
RUN pnpm install --frozen-lockfile --filter @lens-monad/indexer...

COPY packages/protocol packages/protocol
COPY apps/indexer apps/indexer

WORKDIR /app/apps/indexer
ENV NODE_ENV=production
ENV PATH=/app/apps/indexer/node_modules/.bin:$PATH
# Ponder listens on $PORT when set (Railway sets it), 42069 otherwise.
EXPOSE 42069
# The Postgres schema comes from DATABASE_SCHEMA, or --schema.
CMD ["ponder", "start"]
