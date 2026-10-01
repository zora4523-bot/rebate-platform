#!/usr/bin/env bash
# Runs inside the verify image; see tools/ops/verify-container.sh for the container setup.
#
#   couli-verify-entrypoint fetch    networked, sees only /in/pnpm-lock.yaml and
#                                    /in/pnpm-workspace.yaml; fills the store volume at /store
#   couli-verify-entrypoint verify   offline; copies /src to /work/repo, installs from the
#                                    read-only store and runs `pnpm verify` under a time limit
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
    echo "[verify] pnpm verify (limit ${limit}s)"
    started=$(date +%s)
    rc=0
    timeout --signal=TERM --kill-after=10 "$limit" pnpm verify || rc=$?
    elapsed=$(( $(date +%s) - started ))
    # `timeout` reports 137 when the command ignored TERM and had to be killed.
    if [ "$rc" -eq 137 ] && [ "$elapsed" -ge "$limit" ]; then rc=124; fi
    echo "[verify] pnpm verify exited ${rc} after ${elapsed}s"
    exit "$rc"
    ;;
  *)
    echo "usage: couli-verify-entrypoint fetch|verify" >&2
    exit 2
    ;;
esac
