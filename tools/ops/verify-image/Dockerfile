# Verify image for `tools/ops/verify-container.sh` (规划/11 §2.3 step 7, §9.3 #6; ADR-0001 §7).
# Built from the trusted root only. The image tag is derived from a hash of this
# directory plus the pnpm and playwright versions, so any edit here produces a new image.
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

# Browser tests (F1-01j; test/vitest.browser.config.ts, Vitest browser mode with the playwright
# provider). Must equal the `playwright@` version of pnpm-lock.yaml exactly: the browser build a
# Playwright release launches is pinned to that release (browsers.json), so another version would
# look for a browser directory that is not there. verify-container.sh always passes --build-arg
# (read from the lockfile of the snapshot, part of the image hash); a guard test keeps this default
# equal to the lockfile. `none` (a branch whose lockfile has no playwright) builds the image
# without a browser; verify-container.sh then refuses --browser and a red run of browser tests.
ARG PLAYWRIGHT_VERSION=1.63.0

# Installed at build time into a fixed, world-readable place: at run time the root file system
# is read-only and HOME is a tmpfs, so Playwright's default (~/.cache/ms-playwright) is unusable.
# Kept in the run-time environment so the playwright package of the workspace finds it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# - `playwright install --with-deps --only-shell chromium`, as root (no sudo in the image):
#   --with-deps apt-installs the shared libraries the browser needs; --only-shell installs only
#   chromium-headless-shell, which is what Playwright launches for `headless: true` without a
#   channel (playwright-core 1.63 ChromiumBrowser.getExecutableName; @vitest/browser-playwright
#   5.0.1 calls chromium.launch({ headless })), so the full Chromium is not needed. Chromium
#   runs with Playwright's default --no-sandbox and --disable-dev-shm-usage, which is what lets it
#   start under --cap-drop ALL, no-new-privileges and the small default /dev/shm.
# - fonts-noto-cjk (Noto Sans CJK SC …) so Chinese text renders with real glyphs in layouts and
#   screenshots; fontconfig for fc-cache, which builds the system font cache now (the run-time
#   root file system is read-only).
# - Then: the npm / npx cache of root and the apt lists are removed, and /ms-playwright is made
#   readable by the non-root user the tests run as.
RUN set -eux; \
    if [ "${PLAYWRIGHT_VERSION}" = none ]; then \
      echo "PLAYWRIGHT_VERSION=none: image without a browser"; \
    else \
      case "${PLAYWRIGHT_VERSION}" in \
        *[!0-9.]* | '' | .* | *. | *..*) echo "bad PLAYWRIGHT_VERSION: ${PLAYWRIGHT_VERSION}" >&2; exit 1 ;; \
      esac; \
      apt-get update; \
      apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk; \
      npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --only-shell chromium; \
      test -n "$(find /ms-playwright -maxdepth 1 -name 'chromium_headless_shell-*' -print -quit)"; \
      fc-cache -f; \
      fc-list | grep -q 'Noto Sans CJK SC'; \
      chmod -R a+rX /ms-playwright; \
      npm cache clean --force; \
      rm -rf /root/.npm /root/.cache /var/lib/apt/lists/*; \
    fi

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
