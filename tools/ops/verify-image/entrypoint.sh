#!/usr/bin/env bash
# Runs inside the verify image; see tools/ops/verify-container.sh for the container setup.
#
#   couli-verify-entrypoint fetch    networked, sees only /in/pnpm-lock.yaml and
#                                    /in/pnpm-workspace.yaml; fills the store volume at /store
#   couli-verify-entrypoint verify   offline; copies /src to /work/repo, installs from the
#                                    read-only store and runs `pnpm verify` under a time limit
#                                    (VERIFY_SCRIPT=verify:fast: `pnpm run verify:fast` instead)
#   couli-verify-entrypoint red      offline; copies /src, installs, then runs only the rule-test
#                                    files named in RED_UNIT / RED_INT (newline separated,
#                                    repository paths under test/) with the Vitest JSON reporter;
#                                    reports go to /out/unit.json and /out/int.json. The tests are
#                                    expected to fail (red): their exit code is recorded in
#                                    /out/*.exit, not returned; tools/guard/red-check.ts judges.
set -euo pipefail

mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

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
    mkdir -p /work/repo
    # node_modules of the host holds darwin binaries; .git is not needed and not exposed.
    # *.tsbuildinfo is git-ignored, so the path guard never sees it: a stale or forged one must
    # not let `tsc -b` skip a project inside the container.
    tar -C /src \
      --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=.tmp \
      --exclude='*.tsbuildinfo' \
      -cf - . | tar -C /work/repo -xf -
    cd /work/repo
    echo "[verify] pnpm install --offline --frozen-lockfile"
    pnpm install --offline --frozen-lockfile --store-dir /store
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
    mkdir -p /work/repo
    tar -C /src \
      --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=.tmp \
      --exclude='*.tsbuildinfo' \
      -cf - . | tar -C /work/repo -xf -
    cd /work/repo
    echo "[red] pnpm install --offline --frozen-lockfile"
    pnpm install --offline --frozen-lockfile --store-dir /store
    cd /work/repo/test
    run_red() { # run_red <name> <newline-separated repo paths> [vitest args…]
      local name="$1" list="$2" files=() f rc=0
      shift 2
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        case "$f" in
          test/*) files+=("${f#test/}") ;;
          *) echo "[red] not under test/, cannot run: $f" ;;
        esac
      done <<<"$list"
      [ "${#files[@]}" -gt 0 ] || return 0
      echo "[red] vitest run ${name}: ${files[*]}"
      timeout --signal=TERM --kill-after=10 "$limit" pnpm exec vitest run "$@" \
        --reporter=json --outputFile="/out/${name}.json" "${files[@]}" || rc=$?
      echo "$rc" >"/out/${name}.exit"
      echo "[red] vitest ${name} exited ${rc} (red is expected)"
    }
    run_red unit "${RED_UNIT:-}"
    run_red int "${RED_INT:-}" --config vitest.integration.config.ts
    ;;
  *)
    echo "usage: couli-verify-entrypoint fetch|verify|red" >&2
    exit 2
    ;;
esac
