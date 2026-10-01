# Verify image for `tools/ops/verify-container.sh` (规划/11 §2.3 step 7, §9.3 #6; ADR-0001 §7).
# Built from the trusted root only. The image tag is derived from a hash of this
# directory plus the pnpm version, so any edit here produces a new image.
FROM node:24-bookworm-slim

# Must equal the root `packageManager` version exactly: with a different pnpm the
# offline install hangs trying to download the requested one (ADR-0001 §7).
# verify-container.sh always passes --build-arg; a guard test keeps this default
# equal to package.json.
ARG PNPM_VERSION=10.33.1

# - postgresql-client-18 from the PGDG repository: `pg_dump` for `pnpm db:check`
#   must match the server major version.
# - git: tools tests build fixture repositories, and planning text is read with
#   `git show <SPEC_REF>:<path>` from the read-only snapshot mounted at /spec
#   (bind mounts belong to another uid, hence safe.directory).
# - procps: `ps` / `pgrep` for the process-group tests of tools/agent.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git procps; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    git config --system --add safe.directory '*'

# pnpm at the exact version, installed with npm. The image does not rely on
# corepack, so its shims are removed to make that explicit.
RUN set -eux; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    test "$(pnpm --version)" = "${PNPM_VERSION}"; \
    rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack; \
    npm cache clean --force; \
    install -d -o node -g node /store /work

COPY --chmod=0755 entrypoint.sh /usr/local/bin/couli-verify-entrypoint

# The root file system is mounted read-only at run time; everything writable
# lives on the /tmp and /work tmpfs mounts.
ENV HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/xdg/cache \
    XDG_STATE_HOME=/tmp/xdg/state \
    XDG_CONFIG_HOME=/tmp/xdg/config \
    XDG_DATA_HOME=/tmp/xdg/data \
    CI=true \
    npm_config_manage_package_manager_versions=false \
    npm_config_store_dir=/store \
    npm_config_update_notifier=false

USER node
WORKDIR /work
