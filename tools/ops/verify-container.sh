#!/usr/bin/env bash
# Out-of-sandbox verification (规划/11 §2.3 steps 3, 5 and 7, §4.1, §9.3 #6; ADR-0001 §4.2 #9, §7).
#
#   verify-container.sh <id> [--worktree <path>] [--fast | --red [--base <ref>]] [--dry-run]
#
#   (default)  `pnpm verify` — the task's verification; it alone decides the task. verify/<n>/
#   --fast     `pnpm run verify:fast` — the entry the Claude Opus implementation subagent uses for
#              its own test runs (default split of 2026-10-05, ops/approvals.yaml id 19). No
#              PostgreSQL, `--network none`. verify-fast/<n>/; never evidence of verification.
#   --red      the isolated red run of the rule tests Codex wrote (规划/11 §2.3 step 3; CR-12):
#              only the task's new rule-test files (inside its trusted test_paths, changed
#              against --base, default the branch point with origin/main), each run by the
#              trusted Vitest project that takes it (tools/ops/red-plan.ts, red-projects.json;
#              a file no project takes stops the run, CR2-04) with the trusted red reporter
#              (verify-image/red-reporter.mjs, keeps the failure causes, CR2-03); reports go to
#              red/<n>/out/<project>.json and tools/guard/red-check.ts reconciles them with the
#              expected list (exit code = red-check's). A project that needs PostgreSQL gets the
#              one-shot database on the internal network; otherwise the run has no network.
#   --dry-run  prints what would run (script, commit, tree, red files) as one JSON line and
#              starts nothing; no run directory is created.
#
# There is no host fallback (CR-01; 规划/11 §4.1, §8): every test or task file runs only in this
# container. `--host` is refused; without Docker the script stops (exit 2) and the run goes to CI.
#
# The container has no way out:
#   - per-run `--internal` network (or none); a one-shot PostgreSQL attached ONLY to it;
#   - worktree mounted read-only at /src and copied to a tmpfs before anything runs;
#   - dependencies from an offline pnpm store (volume keyed by the lockfile hash;
#     filled by one networked `pnpm fetch` that sees nothing but the lockfile and
#     pnpm-workspace.yaml);
#   - non-root, read-only root file system, no capabilities, no Docker socket; the red run
#     additionally mounts its own output directory (reports only);
#   - planning text for guards and tools tests comes from a read-only, single-commit
#     snapshot of the planning repository at SPEC_REF, mounted at /spec.
# Exit code = the exit code of the script run (124 = time limit); --red: red-check's. Exit code
# 2 = usage or infrastructure error (no result.json is written in that case).
#
# Output: <runs>/<id>/{verify,verify-fast,red}/<n>/log.txt and result.json
#   { mode: container, script: verify|verify:fast|red, exit_code, commit, tree, prop_seed,
#     started_at, finished_at }  — red adds red_tests, expected and reports (path + sha256).
# `tree` is the git tree of the work tree as verified (uncommitted changes included). The tree
# is exported once into an immutable snapshot and that snapshot is what gets verified, so the
# hash and the exit code always describe the same files; git-ignored paths never reach it.
#
# This script, the Dockerfile and the entrypoint are gates: run them from the
# trusted root, never from the task worktree (规划/11 §2.4).
#
# Environment: COULI_RUNS, COULI_TRUSTED_ROOT, COULI_SPEC_REPO (conventions C7);
#   COULI_VERIFY_TIMEOUT_SECS (default 1200); COULI_VERIFY_PREFIX (default couli-verify;
#   prefix of every container, network and volume this script creates);
#   PROP_SEED / PROP_RUNS are passed through.
set -euo pipefail

PG_IMAGE='pgvector/pgvector:0.8.6-pg18-trixie'
DEFAULT_PROP_SEED=20261001

log() { printf '%s\n' "$*" >&2; }
die() { log "verify-container: $*"; exit 2; }
usage() { log "usage: verify-container.sh <id> [--worktree <path>] [--fast | --red [--base <ref>]] [--dry-run]"; exit 2; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1
  fi
}

now_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# True when $1 is $2 or lies below it (both absolute, physical paths).
is_under() {
  [ -n "$2" ] || return 1
  case "$1/" in "$2"/*) return 0 ;; esac
  return 1
}

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF_ROOT="$(cd "$SELF_DIR/../.." && pwd -P)"

ID=''
WORKTREE=''
MODE='container'
SCRIPT='verify'
BASE_ARG=''
DRY_RUN=0
set_script() {
  [ "$SCRIPT" = verify ] || die "give at most one of --fast and --red"
  SCRIPT="$1"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --fast)
      set_script 'verify:fast'
      shift
      ;;
    --red)
      set_script 'red'
      shift
      ;;
    --base)
      [ $# -ge 2 ] || usage
      BASE_ARG="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --worktree)
      [ $# -ge 2 ] || usage
      WORKTREE="$2"
      shift 2
      ;;
    --host)
      # CR-01: a host run would execute the task's (Codex-written) tests and code on the host.
      die "--host is no longer accepted: tests and task code run only in the isolated container (规划/11 §4.1, §8). Start Docker, or hand the run to CI."
      ;;
    -h | --help) usage ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$ID" ] || usage
      ID="$1"
      shift
      ;;
  esac
done
[ -n "$ID" ] || usage
if ! [[ "$ID" =~ ^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$ ]]; then die "invalid task id: $ID"; fi
if [ -n "$BASE_ARG" ] && [ "$SCRIPT" != red ]; then die "--base applies to --red only"; fi
if [ -n "$BASE_ARG" ] && ! [[ "$BASE_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$ ]]; then die "invalid --base: $BASE_ARG"; fi

# Same layout rule as tools/lib/paths.ts.
parent="$(dirname "$SELF_ROOT")"
case "$(basename "$parent")" in
  worktrees | trusted)
    RUNS="$(dirname "$parent")"
    PROJECTS="$(dirname "$RUNS")"
    ;;
  *)
    RUNS="$parent/couli-runs"
    PROJECTS="$parent"
    ;;
esac
if [ -n "${COULI_RUNS:-}" ]; then
  mkdir -p "$COULI_RUNS"
  RUNS="$(cd "$COULI_RUNS" && pwd -P)"
fi

if [ -n "${COULI_TRUSTED_ROOT:-}" ]; then
  TRUSTED="$(cd "$COULI_TRUSTED_ROOT" && pwd -P)"
elif [ -d "$RUNS/trusted/rebate-platform/tools/guard" ]; then
  TRUSTED="$(cd "$RUNS/trusted/rebate-platform" && pwd -P)"
else
  TRUSTED="$SELF_ROOT"
fi
if [ "$TRUSTED" != "$SELF_ROOT" ]; then
  die "run this script from the trusted root: $TRUSTED/tools/ops/verify-container.sh"
fi
# A task worktree is the Codex sandbox's writable root: it can never be the trusted root, with
# or without COULI_TRUSTED_ROOT (规划/11 §2.4; same rule as tools/lib/paths.ts).
case "$SELF_ROOT/" in
  "$RUNS"/worktrees/?* | */couli-runs/worktrees/?*)
    die "refusing to run from the task worktree $SELF_ROOT: gates are never read from the branch under test (规划/11 §2.4)"
    ;;
esac
IMG_DIR="$SELF_DIR/verify-image"

[ -n "$WORKTREE" ] || WORKTREE="$RUNS/worktrees/$ID"
[ -d "$WORKTREE" ] || die "worktree does not exist: $WORKTREE"
WT="$(cd "$WORKTREE" && pwd -P)"

# /tmp and $TMPDIR are writable roots of the Codex sandbox (规划/11 §0, §2.4):
# a worktree there could have been rewritten by the run we are about to verify.
tmp_phys=''
if [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR%/}" ]; then tmp_phys="$(cd "${TMPDIR%/}" && pwd -P)"; fi
for bad in /tmp /private/tmp "${TMPDIR:-}" "$tmp_phys"; do
  bad="${bad%/}"
  if is_under "$WT" "$bad"; then die "refusing a worktree under $bad: $WT"; fi
done

[ -f "$WT/package.json" ] || die "no package.json in $WT"

MAX_TIMEOUT_SECS=1200
TIMEOUT_SECS="${COULI_VERIFY_TIMEOUT_SECS:-$MAX_TIMEOUT_SECS}"
if ! [[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]]; then die "COULI_VERIFY_TIMEOUT_SECS must be a positive integer"; fi
# The switch can only tighten the limit (.env.example: 都只能收紧).
if [ "$TIMEOUT_SECS" -gt "$MAX_TIMEOUT_SECS" ]; then die "COULI_VERIFY_TIMEOUT_SECS is capped at $MAX_TIMEOUT_SECS"; fi
PROP_SEED_VALUE="${PROP_SEED:-$DEFAULT_PROP_SEED}"
if ! [[ "$PROP_SEED_VALUE" =~ ^[0-9]+$ ]]; then die "PROP_SEED must be a non-negative integer"; fi
if [ -n "${PROP_RUNS:-}" ] && ! [[ "$PROP_RUNS" =~ ^[1-9][0-9]*$ ]]; then die "PROP_RUNS must be a positive integer"; fi
PREFIX="${COULI_VERIFY_PREFIX:-couli-verify}"
if ! [[ "$PREFIX" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then die "COULI_VERIFY_PREFIX must match [a-z0-9][a-z0-9-]*"; fi

# The red run: which rule-test files the task added (inside its trusted test_paths), against the
# base. The same list is what red-check reconciles the reports with (CR-10).
RED_FILES=''
RED_PLAN=''
RED_DB=0
if [ "$SCRIPT" = red ]; then
  if [ -z "$BASE_ARG" ]; then
    for candidate in origin/main main; do
      if git -C "$WT" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null 2>&1; then
        BASE_ARG="$(git -C "$WT" merge-base HEAD "$candidate" 2>/dev/null || true)"
        [ -z "$BASE_ARG" ] || break
      fi
    done
  fi
  [ -n "$BASE_ARG" ] || die "--red needs a base (no origin/main or main in $WT): pass --base <ref>"
  RED_FILES="$(cd "$TRUSTED" && node tools/guard/red-check.ts --task "$ID" --cwd "$WT" --base "$BASE_ARG" --print-expected)" ||
    die "cannot list the task's rule-test files (trusted ledger, test_paths)"
  [ -n "$RED_FILES" ] || die "task $ID added no rule-test file inside its test_paths (against $BASE_ARG): nothing to run red"
  while IFS= read -r f; do
    [[ "$f" =~ ^[A-Za-z0-9_./@-]+$ ]] && [[ "$f" != *..* ]] || die "unexpected rule-test path: $f"
  done <<<"$RED_FILES"
  # Which trusted Vitest project runs each file (CR2-04); a file without one stops the run.
  mkdir -p "$RUNS"
  red_list="$RUNS/.red-expected.$ID.$$"
  printf '%s\n' "$RED_FILES" >"$red_list"
  RED_PLAN="$(cd "$TRUSTED" && node tools/ops/red-plan.ts --expected "$red_list" 2>&1)" || {
    rm -f "$red_list"
    die "the red run cannot run every rule-test file: $RED_PLAN"
  }
  rm -f "$red_list"
  RED_DB="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).groups.some((g) => g.database) ? "1" : "0")' "$RED_PLAN")"
fi

tree_of_worktree() { # prints the git tree of the work tree (uncommitted changes included)
  local idx="$1" t
  if [ -n "$head" ]; then GIT_INDEX_FILE="$idx" git -C "$WT" read-tree HEAD; fi
  GIT_INDEX_FILE="$idx" git -C "$WT" add -A . >/dev/null
  t="$(GIT_INDEX_FILE="$idx" git -C "$WT" write-tree)"
  rm -f "$idx" "$idx.lock"
  [[ "$t" =~ ^[0-9a-f]{40,64}$ ]] || die "cannot compute the tree of $WT"
  printf '%s' "$t"
}

RUN="$RUNS/$ID"
top="$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null || true)"
IS_TOP=0
if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$WT" ]; then IS_TOP=1; fi
head=''
if [ "$IS_TOP" = 1 ]; then head="$(git -C "$WT" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null || true)"; fi

if [ "$DRY_RUN" = 1 ]; then
  mkdir -p "$RUNS"
  dry_tree='null'
  if [ "$IS_TOP" = 1 ]; then dry_tree="\"$(tree_of_worktree "$RUNS/.dry-index.$ID.$$")\""; fi
  node -e '
    const [script, commit, tree, files, plan] = process.argv.slice(1);
    const out = { script, commit: commit === "" ? null : commit, tree: JSON.parse(tree) };
    if (script === "red") {
      out.red_files = files.split("\n").filter((l) => l !== "");
      out.red_plan = JSON.parse(plan).groups;
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  ' "$SCRIPT" "$head" "$dry_tree" "$RED_FILES" "$RED_PLAN"
  exit 0
fi

# Next free run number; mkdir makes the choice atomic.
case "$SCRIPT" in
  verify) VBASE="$RUN/verify" ;;
  verify:fast) VBASE="$RUN/verify-fast" ;;
  red) VBASE="$RUN/red" ;;
esac
mkdir -p "$VBASE"
N=1
while ! mkdir "$VBASE/$N" 2>/dev/null; do
  N=$((N + 1))
  [ "$N" -le 9999 ] || die "cannot create a run directory under $VBASE"
done
VDIR="$VBASE/$N"
LOG="$VDIR/log.txt"
RESULT="$VDIR/result.json"
: >"$LOG"

# What exactly is being verified. The worktree is exported ONCE into an immutable snapshot
# (SRC); the tree hash is computed from that snapshot and the snapshot — never the live
# worktree — is what the container (or the host run) sees. A worktree changed while the image
# is built or the store is filled therefore cannot make result.json describe one tree and the
# exit code another. git-ignored paths (node_modules, dist, .env*, *.key, coverage, reports …)
# are not part of a git tree and so never reach the verified copy.
# Only a worktree that is the top of its own git work tree gets commit and tree; a plain
# directory (or one nested in another repository) gets null and is copied with the same
# exclusions the image uses.
COMMIT='null'
TREE='null'
SRC="$VDIR/src"
mkdir -p "$SRC"
# The snapshot is removed however the script ends (container mode replaces this trap with
# cleanup(), which removes it as well).
trap 'rm -rf "$SRC"' EXIT
if [ "$IS_TOP" = 1 ]; then
  [ -z "$head" ] || COMMIT="\"$head\""
  # A throwaway index: the real index (the orchestrator's staging area) is not touched.
  tree="$(tree_of_worktree "$VDIR/index.tmp")"
  TREE="\"$tree\""
  # Export exactly that tree object (deterministic: the archive is built from the object
  # database, not from the live files; .gitattributes sets no export-ignore).
  git -C "$WT" archive --format=tar "$tree" | tar -C "$SRC" -xf - ||
    die "cannot export tree $tree of $WT"
else
  tar -C "$WT" \
    --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=.tmp \
    --exclude=coverage --exclude=reports --exclude='*.tsbuildinfo' --exclude='.env' \
    --exclude='.env.*' --exclude='*.key' --exclude='*.pem' --exclude='*.p12' --exclude='*.pfx' \
    --exclude='*.jks' --exclude='*.keystore' \
    -cf - . | tar -C "$SRC" -xf - || die "cannot copy $WT"
  # .env.example is the one environment file that belongs to the repository.
  if [ -f "$WT/.env.example" ]; then cp "$WT/.env.example" "$SRC/.env.example"; fi
fi

STARTED_AT="$(now_utc)"

write_result() {
  local tmp="$RESULT.tmp.$$"
  printf '{\n  "mode": "%s",\n  "script": "%s",\n  "exit_code": %s,\n  "commit": %s,\n  "tree": %s,\n  "prop_seed": %s,\n  "started_at": "%s",\n  "finished_at": "%s"\n}\n' \
    "$MODE" "$SCRIPT" "$1" "$COMMIT" "$TREE" "$PROP_SEED_VALUE" "$STARTED_AT" "$(now_utc)" >"$tmp"
  if [ "$SCRIPT" = red ] && [ -f "$VDIR/red-check.json" ]; then
    # The red tests, the expected files and the exported reports with their sha256 (evidence).
    node -e '
      const fs = require("node:fs");
      const crypto = require("node:crypto");
      const [file, check, outDir] = process.argv.slice(1);
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      const red = JSON.parse(fs.readFileSync(check, "utf8"));
      result.red_tests = red.red ?? [];
      result.expected = red.expected ?? [];
      result.reports = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort().map((f) => ({
        path: `out/${f}`,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(`${outDir}/${f}`)).digest("hex"),
      }));
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    ' "$tmp" "$VDIR/red-check.json" "$VDIR/out" || die "cannot record the red run in result.json"
  fi
  mv "$tmp" "$RESULT"
}

finish() {
  write_result "$1"
  # The snapshot is identified by `tree` in result.json; the copy itself is not kept.
  rm -rf "$SRC"
  log "verify-container: $ID run $N ($MODE, $SCRIPT) exit $1; log: $LOG"
  cat "$RESULT"
  exit "$1"
}

# --- container mode ----------------------------------------------------------
[ -f "$SRC/pnpm-lock.yaml" ] || die "no pnpm-lock.yaml in $WT"
[ -f "$SRC/pnpm-workspace.yaml" ] || die "no pnpm-workspace.yaml in $WT"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
  die "Docker is not available. Start Docker, or hand the run to CI (there is no host fallback: 规划/11 §4.1, §8)."

PNPM_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' "$SRC/package.json" | head -n 1)"
if ! [[ "$PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "package.json must pin \"packageManager\": \"pnpm@<exact version>\""
fi

IMAGE_HASH="$({
  cat "$IMG_DIR/Dockerfile" "$IMG_DIR/entrypoint.sh"
  printf 'pnpm@%s\n' "$PNPM_VERSION"
} | sha256_stdin | cut -c1-16)"
IMAGE="couli-verify:$IMAGE_HASH"
LOCK_HASH="$(sha256_stdin <"$SRC/pnpm-lock.yaml" | cut -c1-16)"
STORE_VOL="$PREFIX-store-$LOCK_HASH"
TAG="$(printf '%s' "$ID" | tr '[:upper:]' '[:lower:]')-$N-$$"
NET="$PREFIX-net-$TAG"
PG_NAME="$PREFIX-pg-$TAG"
VERIFY_NAME="$PREFIX-run-$TAG"
FETCH_NAME="$PREFIX-fetch-$TAG"
STORE_LOCK="$RUNS/lock/verify-store-$LOCK_HASH"
LABELS=(--label "couli.verify=1" --label "couli.task=$ID")
HARDEN=(--init --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096)
TMPFS=(--tmpfs "/work:rw,exec,nosuid,uid=1000,gid=1000,mode=0755" --tmpfs "/tmp:rw,exec,nosuid,uid=1000,gid=1000,mode=1777")

net_created=0
store_locked=0
cleanup() {
  # Signals do not reach processes inside a container: remove them explicitly.
  docker rm -f -v "$VERIFY_NAME" "$FETCH_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  if [ "$net_created" -eq 1 ]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
  if [ "$store_locked" -eq 1 ]; then rmdir "$STORE_LOCK" 2>/dev/null || true; fi
  rm -rf "$SRC"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step() {
  log "verify-container: $*"
  printf '[verify-container %s] %s\n' "$(now_utc)" "$*" >>"$LOG"
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  step "building image $IMAGE (pnpm $PNPM_VERSION)"
  docker build -t "$IMAGE" --build-arg "PNPM_VERSION=$PNPM_VERSION" --label "couli.verify=1" "$IMG_DIR" >>"$LOG" 2>&1 ||
    die "image build failed, see $LOG"
fi

store_ready() {
  docker volume inspect "$STORE_VOL" >/dev/null 2>&1 &&
    docker run --rm --network none -v "$STORE_VOL:/store:ro" "$IMAGE" test -f /store/.couli-fetch-ok >/dev/null 2>&1
}

if ! store_ready; then
  # One fetch per lockfile at a time; a second run waits for the first.
  mkdir -p "$RUNS/lock"
  waited=0
  while ! mkdir "$STORE_LOCK" 2>/dev/null; do
    [ "$waited" -lt 900 ] || die "another run holds $STORE_LOCK for more than 15 minutes"
    sleep 5
    waited=$((waited + 5))
  done
  store_locked=1
  if ! store_ready; then
    step "filling offline store $STORE_VOL (networked pnpm fetch; sees only the lockfile and pnpm-workspace.yaml)"
    docker volume create --label "couli.verify=1" "$STORE_VOL" >/dev/null
    docker run --rm --name "$FETCH_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
      -v "$SRC/pnpm-lock.yaml:/in/pnpm-lock.yaml:ro" \
      -v "$SRC/pnpm-workspace.yaml:/in/pnpm-workspace.yaml:ro" \
      -v "$STORE_VOL:/store" \
      "$IMAGE" couli-verify-entrypoint fetch >>"$LOG" 2>&1 </dev/null ||
      die "pnpm fetch failed, see $LOG"
  fi
  rmdir "$STORE_LOCK" 2>/dev/null || true
  store_locked=0
fi

# Planning text at SPEC_REF for guards and tools tests: a single-commit bare
# snapshot, so the container sees neither the planning work tree nor its config.
SPEC_ARGS=()
if [ -f "$SRC/SPEC_REF" ]; then
  spec_ref="$(tr -d '[:space:]' <"$SRC/SPEC_REF")"
  spec_repo="${COULI_SPEC_REPO:-$PROJECTS/couli}"
  if [[ "$spec_ref" =~ ^[0-9a-f]{40}$ ]] && git -C "$spec_repo" cat-file -e "$spec_ref^{commit}" 2>/dev/null; then
    snap="$RUNS/spec-snapshots/$spec_ref.git"
    if [ ! -f "$snap/.couli-snapshot-ok" ]; then
      step "creating planning snapshot for SPEC_REF $spec_ref"
      rm -rf "$snap.tmp.$$"
      mkdir -p "$RUNS/spec-snapshots"
      git init -q --bare "$snap.tmp.$$" >>"$LOG" 2>&1
      git -C "$snap.tmp.$$" -c protocol.file.allow=always fetch -q --depth 1 "file://$(cd "$spec_repo" && pwd -P)" "$spec_ref" >>"$LOG" 2>&1 ||
        die "cannot snapshot the planning repository at $spec_ref, see $LOG"
      touch "$snap.tmp.$$/.couli-snapshot-ok"
      # A concurrent run may have finished the same snapshot first: keep theirs.
      if [ -e "$snap" ]; then rm -rf "$snap.tmp.$$"; else mv "$snap.tmp.$$" "$snap"; fi
    fi
    # The snapshot has no history, so "SPEC_REF is on the planning main" (规划/11 §5.3)
    # is checked here, against the real repository; only then does the snapshot get an
    # origin/main for the spec-ref guard inside the container to compare with.
    if ! git -C "$snap" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
      if git -C "$spec_repo" merge-base --is-ancestor "$spec_ref" origin/main 2>/dev/null; then
        git -C "$snap" update-ref refs/remotes/origin/main "$spec_ref"
      else
        step "SPEC_REF $spec_ref is not on origin/main of $spec_repo: the spec-ref guard will fail"
      fi
    fi
    SPEC_ARGS=(-v "$snap:/spec:ro" -e COULI_SPEC_REPO=/spec)
  else
    step "SPEC_REF is not a commit of $spec_repo: /spec is not mounted"
  fi
fi

if [ "$SCRIPT" = red ]; then
  # Groups of the plan (tools/ops/red-plan.ts); a group needing PostgreSQL gets the one-shot
  # database on the internal network, otherwise the run has no network at all.
  printf '%s\n' "$RED_FILES" >"$VDIR/expected.txt"
  printf '%s\n' "$RED_PLAN" >"$VDIR/plan.json"
  mkdir -p "$VDIR/out"
  chmod 0777 "$VDIR/out"
  RED_ENV=(-e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS" -e RED_PLAN)
  [ -z "${PROP_RUNS:-}" ] || RED_ENV+=(-e "PROP_RUNS=$PROP_RUNS")
  RED_NET=(--network none)
  if [ "$RED_DB" = 1 ]; then
    step "creating internal network $NET (integration rule tests)"
    docker network create --internal "${LABELS[@]}" "$NET" >/dev/null
    net_created=1
    step "starting one-shot PostgreSQL ($PG_IMAGE) on $NET only"
    PG_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    POSTGRES_PASSWORD="$PG_PASSWORD" docker run -d --name "$PG_NAME" "${LABELS[@]}" \
      --network "$NET" --network-alias pg --tmpfs /var/lib/postgresql -e POSTGRES_PASSWORD \
      "$PG_IMAGE" >/dev/null 2>>"$LOG" || die "cannot start PostgreSQL, see $LOG"
    tries=0
    until docker exec "$PG_NAME" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -lt 120 ] || die "PostgreSQL did not become ready within 60 seconds, see $LOG"
      sleep 0.5
    done
    RED_NET=(--network "$NET")
    RED_ENV+=(-e TEST_PG_ADMIN_URL)
    export TEST_PG_ADMIN_URL="postgres://postgres:$PG_PASSWORD@pg:5432/postgres"
  fi
  step "running the task's rule tests (red run) in $IMAGE (limit ${TIMEOUT_SECS}s)"
  export RED_PLAN
  red_rc=0
  docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
    "${RED_NET[@]}" \
    -v "$SRC:/src:ro" \
    -v "$STORE_VOL:/store:ro" \
    -v "$VDIR/out:/out" \
    -v "$IMG_DIR/red-reporter.mjs:/red/red-reporter.mjs:ro" \
    --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
    ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
    "${RED_ENV[@]}" \
    "$IMAGE" couli-verify-entrypoint red >>"$LOG" 2>&1 </dev/null || red_rc=$?
  [ "$red_rc" = 0 ] || die "the red run did not produce its reports (exit $red_rc), see $LOG"
  # Every group must have written its report (the red reporter, with failure causes).
  reports=''
  for name in $(node -e 'for (const g of JSON.parse(process.argv[1]).groups) console.log(g.name)' "$RED_PLAN"); do
    [ -f "$VDIR/out/$name.json" ] || die "the red run wrote no report for $name, see $LOG"
    reports="${reports:+$reports,}$VDIR/out/$name.json"
  done
  [ -n "$reports" ] || die "the red run wrote no report, see $LOG"
  rc=0
  (cd "$TRUSTED" && node tools/guard/red-check.ts --task "$ID" --report "$reports" \
    --expected-list "$VDIR/expected.txt" --root /work/repo --json) \
    >"$VDIR/red-check.json" 2>>"$LOG" || rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 1 ] || die "red-check failed to run (exit $rc), see $LOG"
  finish "$rc"
fi

if [ "$SCRIPT" = 'verify:fast' ]; then
  # verify:fast connects to no database and no network (规划/11 §4.1): no PostgreSQL, no
  # network at all.
  step "running pnpm run verify:fast in $IMAGE (no network, limit ${TIMEOUT_SECS}s)"
  FAST_ENV=(-e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS" -e "VERIFY_SCRIPT=verify:fast")
  [ -z "${PROP_RUNS:-}" ] || FAST_ENV+=(-e "PROP_RUNS=$PROP_RUNS")
  rc=0
  docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
    --network none \
    -v "$SRC:/src:ro" \
    -v "$STORE_VOL:/store:ro" \
    --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
    ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
    "${FAST_ENV[@]}" \
    "$IMAGE" couli-verify-entrypoint verify >>"$LOG" 2>&1 </dev/null || rc=$?
  finish "$rc"
fi

step "creating internal network $NET"
docker network create --internal "${LABELS[@]}" "$NET" >/dev/null
net_created=1

step "starting one-shot PostgreSQL ($PG_IMAGE) on $NET only"
PG_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
POSTGRES_PASSWORD="$PG_PASSWORD" docker run -d --name "$PG_NAME" "${LABELS[@]}" \
  --network "$NET" --network-alias pg \
  --tmpfs /var/lib/postgresql \
  -e POSTGRES_PASSWORD \
  "$PG_IMAGE" >/dev/null 2>>"$LOG" || die "cannot start PostgreSQL, see $LOG"
ready=0
tries=0
while [ "$tries" -lt 120 ]; do
  # TCP only: the image first runs a temporary server that listens on the socket alone.
  if docker exec "$PG_NAME" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
  tries=$((tries + 1))
done
if [ "$ready" -ne 1 ]; then
  docker logs "$PG_NAME" >>"$LOG" 2>&1 || true
  die "PostgreSQL did not become ready within 60 seconds, see $LOG"
fi

step "running pnpm verify in $IMAGE (limit ${TIMEOUT_SECS}s)"
ENV_ARGS=(-e TEST_PG_ADMIN_URL -e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS")
[ -z "${PROP_RUNS:-}" ] || ENV_ARGS+=(-e "PROP_RUNS=$PROP_RUNS")
rc=0
TEST_PG_ADMIN_URL="postgres://postgres:$PG_PASSWORD@pg:5432/postgres" \
  docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
  --network "$NET" \
  -v "$SRC:/src:ro" \
  -v "$STORE_VOL:/store:ro" \
  --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
  ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
  "${ENV_ARGS[@]}" \
  "$IMAGE" couli-verify-entrypoint verify >>"$LOG" 2>&1 </dev/null || rc=$?

finish "$rc"
