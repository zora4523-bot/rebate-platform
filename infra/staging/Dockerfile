# Backend image for staging (B1-01zc). One image serves all five process entries
# (api / stream / worker / admin / payout) and the one-shot migration step; compose
# chooses the entry with `command`. Built on the developer machine from the repository root:
#   docker buildx build --platform linux/amd64 -f infra/staging/Dockerfile -t couli-api:<tag> .
# No environment file or credential is copied into the image: every connection string
# comes from the node's /etc/couli files at run time.

FROM node:24-bookworm-slim AS build
# Exactly the pnpm from package.json `packageManager` (ADR-0001 §7); never self-switch.
RUN npm install --global --no-fund --no-audit pnpm@10.33.1
WORKDIR /app

# Dependencies first, from the lockfile only, so this layer is reused until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile

COPY . .
# Offline install from the fetched store: the lockfile is the only source of versions.
RUN pnpm install --offline --frozen-lockfile
# Builds @couli/api and the workspace packages it references (tsc -b).
RUN pnpm --filter @couli/api run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The whole built workspace: apps/api/dist, packages/*/dist, db/migrations and the
# node_modules links. The migration step (packages/db/scripts/migrate.ts) needs
# node-pg-migrate, a devDependency of @couli/db, so dev dependencies are kept.
COPY --from=build /app /app
# Files stay owned by root, so the process user can read but not modify them.
USER node
# Default entry; compose overrides it per service (node apps/api/dist/main.<entry>.js).
CMD ["node", "apps/api/dist/main.api.js"]
