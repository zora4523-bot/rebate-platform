#!/usr/bin/env bash
# Runs inside the verify image; see tools/ops/verify-container.sh for the container setup.
#
#   couli-verify-entrypoint fetch    networked, sees only /in/pnpm-lock.yaml and
#                                    /in/pnpm-workspace.yaml; fills the store volume at /store
#   couli-verify-entrypoint verify   offline; copies /src to /work/repo, installs from the
#                                    read-only store and runs `pnpm verify` under a time limit
#                                    (VERIFY_SCRIPT=verify:fast: `pnpm run verify:fast` instead)
#   couli-verify-entrypoint red      offline; copies /src, installs, then runs the groups of
#                                    RED_PLAN (JSON from tools/ops/red-plan.ts: project dir,
#                                    Vitest config, files) each with the trusted reporter
#                                    /red/red-reporter.mjs (mounted read-only); reports go to
#                                    /out/<project>.json. The tests are expected to fail (red):
#                                    their exit code is recorded in /out/<project>.exit, not
#                                    returned; tools/guard/red-check.ts judges.
#   couli-verify-entrypoint browser  offline; copies /src, installs, then runs the browser project
#                                    (BROWSER_DIR, BROWSER_CONFIG: from the trusted
#                                    red-projects.json) in a real Chromium under a time limit.
#                                    Screenshots go to /out/screenshots, Vitest's JSON report to
#                                    /out/vitest-report.json; the exit code is Vitest's. Needs an
#                                    image built with Playwright's browser (PLAYWRIGHT_VERSION).
set -euo pipefail

mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

# Copies the read-only snapshot /src to /work/repo and installs from the offline store.
# node_modules of the host holds darwin binaries; .git is not needed and not exposed.
# *.tsbuildinfo is git-ignored, so the path guard never sees it: a stale or forged one must
# not let `tsc -b` skip a project inside the container.
prepare_repo() { # <log tag>
  mkdir -p /work/repo
  tar -C /src \
    --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=.tmp \
    --exclude='*.tsbuildinfo' \
    -cf - . | tar -C /work/repo -xf -
  cd /work/repo
  echo "[$1] pnpm install --offline --frozen-lockfile"
  pnpm install --offline --frozen-lockfile --store-dir /store
}

# A plan or project entry: a plain relative path (no `..`, no spaces, no shell syntax).
plain_path() {
  [[ "$1" =~ ^[A-Za-z0-9_./@-]+$ ]] && [[ "$1" != *..* ]] && [[ "$1" != /* ]]
}

case "${1:-}" in
  fetch)
    mkdir -p /work/fetch
    cd /work/fetch
    cp /in/pnpm-lock.yaml /in/pnpm-workspace.yaml .
    pnpm fetch --store-dir /store
    # Mount point for the tmpfs that covers the per-project registry of a read-only store.
    mkdir -p /store/v10/projects
    touch /store/.couli-fetch-ok
    ;;
  verify)
    limit="${VERIFY_TIMEOUT_SECS:?VERIFY_TIMEOUT_SECS is required}"
    script="${VERIFY_SCRIPT:-verify}"
    case "$script" in
      verify | verify:fast) ;;
      *)
        echo "VERIFY_SCRIPT must be verify or verify:fast" >&2
        exit 2
        ;;
    esac
    prepare_repo verify
    echo "[verify] pnpm run ${script} (limit ${limit}s)"
    started=$(date +%s)
    rc=0
    timeout --signal=TERM --kill-after=10 "$limit" pnpm run "$script" || rc=$?
    elapsed=$(( $(date +%s) - started ))
    # `timeout` reports 137 when the command ignored TERM and had to be killed.
    if [ "$rc" -eq 137 ] && [ "$elapsed" -ge "$limit" ]; then rc=124; fi
    echo "[verify] pnpm run ${script} exited ${rc} after ${elapsed}s"
    exit "$rc"
    ;;
  red)
    limit="${VERIFY_TIMEOUT_SECS:?VERIFY_TIMEOUT_SECS is required}"
    prepare_repo red
    cd /work/repo/test
    [ -f /red/red-reporter.mjs ] || { echo "[red] /red/red-reporter.mjs is not mounted" >&2; exit 2; }
    plan_lines="$(node -e '
      const plan = JSON.parse(process.env.RED_PLAN ?? "");
      const ok = (s) => typeof s === "string" && /^[A-Za-z0-9_.\/@-]+$/.test(s) && !s.includes("..");
      for (const g of plan.groups) {
        if (![g.name, g.dir, g.config, ...g.files].every(ok)) throw new Error("bad plan entry");
        console.log([g.name, g.dir, g.config, ...g.files].join(" "));
      }
    ')" || { echo "[red] RED_PLAN is missing or invalid" >&2; exit 2; }
    while read -r name dir config files; do
      [ -n "$name" ] || continue
      rc=0
      echo "[red] ${name}: vitest run --config ${config} in ${dir}: ${files}"
      # shellcheck disable=SC2086 # files: one word per path, validated above
      (cd "/work/repo/$dir" && RED_REPORT_OUT="/out/${name}.json" timeout --signal=TERM \
        --kill-after=10 "$limit" pnpm exec vitest run --config "$config" \
        --reporter=/red/red-reporter.mjs $files) || rc=$?
      echo "$rc" >"/out/${name}.exit"
      echo "[red] ${name} exited ${rc} (red is expected)"
    done <<<"$plan_lines"
    ;;
  browser)
    limit="${VERIFY_TIMEOUT_SECS:?VERIFY_TIMEOUT_SECS is required}"
    dir="${BROWSER_DIR:-}"
    config="${BROWSER_CONFIG:-}"
    if ! plain_path "$dir" || ! plain_path "$config"; then
      echo "[browser] BROWSER_DIR and BROWSER_CONFIG must be plain relative paths" >&2
      exit 2
    fi
    [ -d /out ] && [ -w /out ] || { echo "[browser] /out is not mounted writable" >&2; exit 2; }
    [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$PLAYWRIGHT_BROWSERS_PATH" ] || {
      echo "[browser] this image has no Playwright browser (built with PLAYWRIGHT_VERSION=none)" >&2
      exit 2
    }
    prepare_repo browser
    mkdir -p /out/screenshots
    echo "[browser] vitest run --config ${config} in ${dir} (limit ${limit}s)"
    started=$(date +%s)
    rc=0
    (cd "/work/repo/$dir" && COULI_BROWSER_SCREENSHOT_DIR=/out/screenshots timeout --signal=TERM \
      --kill-after=10 "$limit" pnpm exec vitest run --config "$config" \
      --reporter=default --reporter=json --outputFile.json=/out/vitest-report.json) || rc=$?
    elapsed=$(( $(date +%s) - started ))
    if [ "$rc" -eq 137 ] && [ "$elapsed" -ge "$limit" ]; then rc=124; fi
    echo "[browser] vitest exited ${rc} after ${elapsed}s"
    exit "$rc"
    ;;
  *)
    echo "usage: couli-verify-entrypoint fetch|verify|red|browser" >&2
    exit 2
    ;;
esac
