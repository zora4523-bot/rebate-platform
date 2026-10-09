#!/usr/bin/env bash
# Out-of-sandbox verification (规划/11 §2.3 steps 3, 5 and 7, §4.1, §9.3 #6; ADR-0001 §4.2 #9, §7).
#
#   verify-container.sh <id> [--worktree <path>] [--fast | --red [--base <ref>] | --browser]
#                           [--dry-run]
#
#   (default)  `pnpm verify` — the task's verification; it alone decides the task. verify/<n>/
#   --fast     `pnpm run verify:fast` — the entry the Claude Opus implementation subagent uses for
#              its own test runs (default split of 2026-10-05, ops/approvals.yaml id 19). No
#              PostgreSQL, no Redis, `--network none`. verify-fast/<n>/; never evidence of
#              verification.
#   --red      the isolated red run of the rule tests Codex wrote (规划/11 §2.3 step 3; CR-12):
#              only the task's new rule-test files (inside its trusted test_paths, changed
#              against --base, default the branch point with origin/main), each run by the
#              trusted Vitest project that takes it (tools/ops/red-plan.ts, red-projects.json;
#              a file no project takes stops the run, CR2-04) with the trusted red reporter
#              (verify-image/red-reporter.mjs, keeps the failure causes, CR2-03); reports go to
#              red/<n>/out/<project>.json and tools/guard/red-check.ts reconciles them with the
#              expected list (exit code = red-check's). The groups whose project needs
#              PostgreSQL run in their own container with the one-shot PostgreSQL and Redis on the
#              internal network; all other groups run in a container with no network and no
#              database URL. A browser rule test (project `browser: true`, spec-browser) needs an
#              image with Playwright's browser: without playwright in the lockfile the run stops.
#   --browser  the browser tests: every browser project of red-projects.json, in its order, in one
#              container with `--network none` (loopback only) and the image's headless Chromium:
#              spec-browser (F1-01j: every test/spec/**/*.browser.test.{ts,tsx}, Vitest browser
#              mode) and build-smoke (F1-01k: builds the H5 entries and the admin console, serves
#              them on 127.0.0.1 and opens each one; every test/spec/**/*.smoke.test.ts).
#              Screenshots and one Vitest JSON report per project are exported to browser/<n>/out/
#              (screenshots/ — the build smoke's are screenshots/smoke-<entry>.png —,
#              <project>.vitest-report.json) for comparison with the design boards; the log counts
#              both kinds. Exit code = the first failing project's (every project still runs), or
#              1 when all passed but no screenshot was exported. Like --fast an implementer's own
#              check, never
#              evidence of verification (tools/ci/evidence-check.ts accepts verify and red only).
#   --dry-run  prints what would run (script, commit, tree, red files) as one JSON line and
#              starts nothing; no run directory is created.
#
# There is no host fallback (CR-01; 规划/11 §4.1, §8): every test or task file runs only in this
# container. `--host` is refused; without Docker the script stops (exit 2) and the run goes to CI.
#
# The container has no way out:
#   - per-run `--internal` network (or none); a one-shot PostgreSQL (TEST_PG_ADMIN_URL) and a
#     one-shot Redis (TEST_REDIS_URL) attached ONLY to it, no published port, data on tmpfs;
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
# Output: <runs>/<id>/{verify,verify-fast,red,browser}/<n>/log.txt and result.json
#   { mode: container, script: verify|verify:fast|red|browser, exit_code, commit, tree,
#     prop_seed, started_at, finished_at }  — red adds red_tests, expected and reports (path +
#     sha256); browser leaves its screenshots and report in out/.
# `tree` is the git tree of the work tree as verified (uncommitted changes included). The tree
# is exported once into an immutable snapshot and that snapshot is what gets verified, so the
# hash and the exit code always describe the same files; git-ignored paths never reach it.
#
# The image: tools/ops/verify-image/Dockerfile with the pnpm of `packageManager` and the
# Playwright browser of the lockfile's `playwright` version (none: no browser); both versions are
# part of the image tag, so a lockfile that moves either one builds a new image.
#
# This script, the Dockerfile and the entrypoint are gates: run them from the
# trusted root, never from the task worktree (规划/11 §2.4).
#
# Environment: COULI_RUNS, COULI_TRUSTED_ROOT, COULI_SPEC_REPO (conventions C7);
#   COULI_VERIFY_TIMEOUT_SECS (default 1200); COULI_VERIFY_PREFIX (default couli-verify;
#   prefix of every container, network and volume this script creates);
#   PROP_SEED / PROP_RUNS are passed through.
#
# External services (owner 2026-10-08: the test database runs on the test machine itself, not in
# Docker): set COULI_VERIFY_PG_SOCKET_DIR and the run that needs databases (pnpm verify, the
# integration groups of --red) uses the host's PostgreSQL and Redis instead of the one-shot
# containers. All of these are then required:
#   COULI_VERIFY_PG_SOCKET_DIR           directory of the PostgreSQL unix socket (.s.PGSQL.<port>)
#   COULI_VERIFY_PG_PORT                 port of that socket file (default 5432)
#   COULI_VERIFY_PG_ADMIN_USER           a superuser of that cluster (password login on the socket)
#   COULI_VERIFY_PG_ADMIN_PASSWORD_FILE  file whose first line is its password (read here only)
#   COULI_VERIFY_REDIS_SOCKET            the Redis unix socket (no password, test-only instance)
# What changes in that mode, and nothing else:
#   - no internal network, no PostgreSQL or Redis container; the database container runs with
#     `--network none` and gets the socket directories bind-mounted read-only;
#   - inside it a small socket proxy (node, written by this script, mounted read-only) listens on
#     127.0.0.1:5432 and 127.0.0.1:6379 and forwards to the two sockets, so TEST_PG_ADMIN_URL is
#     postgres://<user>:<password>@127.0.0.1:5432/postgres and TEST_REDIS_URL redis://127.0.0.1:6379/0
#     (packages/db/src/pg-url.ts and the test Redis probe take host:port URLs only; pg_dump of
#     db:check connects the same way). The password reaches the container only by name (`-e`);
#   - the cluster is shared and lives on: runs that use it are serialised by the lock directory
#     <runs>/lock/verify-external-services (a stale one, whose process is gone, is taken over), and
#     before and after each such run the databases and roles test runs create
#     (couli_tpl_* / couli_t_* / couli_snap_* databases, couli_factory_* roles) are dropped and
#     Redis is emptied (FLUSHALL). The cluster-wide bootstrap roles (couli_migrator …) stay; every
#     run sets the same derived passwords on them. The cluster's template1 must be bare (only
#     plpgsql, as in the one-shot image), since every test database is created from it: the
#     cleanup refuses to start a run otherwise;
#   - result.json of such a run has "services": "external".
# Unset, the script behaves exactly as without these lines.
set -euo pipefail

PG_IMAGE='pgvector/pgvector:0.8.6-pg18-trixie'
# Same image as infra/local/compose.yaml and the verify-int job of .github/workflows/ci.yml.
REDIS_IMAGE='redis:7.4.11-alpine'
DEFAULT_PROP_SEED=20261001

log() { printf '%s\n' "$*" >&2; }
die() { log "verify-container: $*"; exit 2; }
usage() { log "usage: verify-container.sh <id> [--worktree <path>] [--fast | --red [--base <ref>] | --browser] [--dry-run]"; exit 2; }

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
  [ "$SCRIPT" = verify ] || die "give at most one of --fast, --red and --browser"
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
    --browser)
      set_script 'browser'
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

# External services (see the header): checked here, used by start_services.
EXT_SERVICES=0
if [ -n "${COULI_VERIFY_PG_SOCKET_DIR:-}" ] || [ -n "${COULI_VERIFY_REDIS_SOCKET:-}" ]; then
  EXT_SERVICES=1
  EXT_PG_DIR="${COULI_VERIFY_PG_SOCKET_DIR:-}"
  EXT_PG_PORT="${COULI_VERIFY_PG_PORT:-5432}"
  EXT_PG_USER="${COULI_VERIFY_PG_ADMIN_USER:-}"
  EXT_PG_PWFILE="${COULI_VERIFY_PG_ADMIN_PASSWORD_FILE:-}"
  EXT_REDIS_SOCKET="${COULI_VERIFY_REDIS_SOCKET:-}"
  if [ -z "$EXT_PG_DIR" ] || [ -z "$EXT_PG_USER" ] || [ -z "$EXT_PG_PWFILE" ] || [ -z "$EXT_REDIS_SOCKET" ]; then
    die "external services need COULI_VERIFY_PG_SOCKET_DIR, COULI_VERIFY_PG_ADMIN_USER, COULI_VERIFY_PG_ADMIN_PASSWORD_FILE and COULI_VERIFY_REDIS_SOCKET"
  fi
  for p in "$EXT_PG_DIR" "$EXT_REDIS_SOCKET"; do
    [[ "$p" == /* ]] && [[ "$p" != *[:,]* ]] || die "external service paths must be absolute, without ':' or ',': $p"
  done
  EXT_PG_DIR="${EXT_PG_DIR%/}"
  [[ "$EXT_PG_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || die "COULI_VERIFY_PG_PORT must be a port number"
  [[ "$EXT_PG_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "COULI_VERIFY_PG_ADMIN_USER must be a plain role name"
  EXT_REDIS_DIR="$(dirname "$EXT_REDIS_SOCKET")"
  EXT_REDIS_BASE="$(basename "$EXT_REDIS_SOCKET")"
fi

# The red run: which rule-test files the task added (inside its trusted test_paths), against the
# base. The same list is what red-check reconciles the reports with (CR-10).
RED_FILES=''
RED_PLAN=''
RED_BROWSER=0
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
  RED_BROWSER="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).groups.some((g) => g.browser) ? "1" : "0")' "$RED_PLAN")"
fi

# --browser: the browser projects of the trusted project table (name, dir and config), in order;
# handed to the entrypoint as BROWSER_PROJECTS ("<name>:<dir>:<config>", space-separated).
BROWSER_PROJECTS=''
if [ "$SCRIPT" = browser ]; then
  browser_projects="$(node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const found = (doc.projects ?? []).filter((p) => p.browser === true);
    if (found.length === 0) throw new Error("expected at least one browser project, found none");
    for (const p of found) console.log(`${p.name} ${p.dir} ${p.config}`);
  ' "$IMG_DIR/red-projects.json" 2>&1)" || die "no browser project in $IMG_DIR/red-projects.json: $browser_projects"
  while read -r b_name b_dir b_config; do
    for p in "$b_name" "$b_dir" "$b_config"; do
      [[ "$p" =~ ^[A-Za-z0-9_./@-]+$ ]] && [[ "$p" != *..* ]] || die "unexpected browser project entry: $p"
    done
    BROWSER_PROJECTS="${BROWSER_PROJECTS:+$BROWSER_PROJECTS }$b_name:$b_dir:$b_config"
  done <<<"$browser_projects"
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
  browser) VBASE="$RUN/browser" ;;
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
# Set by start_services when the run used the external services (empty otherwise).
SERVICES_FIELD=''

write_result() {
  local tmp="$RESULT.tmp.$$"
  printf '{\n  "mode": "%s",\n  "script": "%s",\n  "exit_code": %s,\n  "commit": %s,\n  "tree": %s,\n  "prop_seed": %s,\n  "started_at": "%s",\n  "finished_at": "%s"%s\n}\n' \
    "$MODE" "$SCRIPT" "$1" "$COMMIT" "$TREE" "$PROP_SEED_VALUE" "$STARTED_AT" "$(now_utc)" "$SERVICES_FIELD" >"$tmp"
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

# The Playwright version of the snapshot's lockfile (a `playwright@<version>:` key; the packages
# and snapshots sections repeat it): the image installs exactly that browser build. `none` when
# the lockfile has no playwright (a branch from before F1-01i): the image has no browser, and
# the runs that need one stop here.
playwright_versions="$(sed -n "s/^  '\{0,1\}playwright@\([^:('][^:(']*\).*:\$/\1/p" "$SRC/pnpm-lock.yaml" | sort -u)"
case "$(printf '%s' "$playwright_versions" | grep -c '' || true)" in
  0) PLAYWRIGHT_VERSION='none' ;;
  1) PLAYWRIGHT_VERSION="$playwright_versions" ;;
  *) die "pnpm-lock.yaml has more than one playwright version: $(printf '%s' "$playwright_versions" | tr '\n' ' ')" ;;
esac
if [ "$PLAYWRIGHT_VERSION" != none ] && ! [[ "$PLAYWRIGHT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "unexpected playwright version in pnpm-lock.yaml: $PLAYWRIGHT_VERSION (the image installs exact releases only)"
fi
if [ "$PLAYWRIGHT_VERSION" = none ]; then
  if [ "$SCRIPT" = browser ]; then
    die "--browser needs playwright in pnpm-lock.yaml: this tree has none, so the verify image is built without a browser"
  fi
  if [ "$RED_BROWSER" = 1 ]; then
    die "the red run has browser rule tests, but pnpm-lock.yaml has no playwright: the verify image is built without a browser"
  fi
fi
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
  die "Docker is not available. Start Docker, or hand the run to CI (there is no host fallback: 规划/11 §4.1, §8)."

PNPM_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' "$SRC/package.json" | head -n 1)"
if ! [[ "$PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "package.json must pin \"packageManager\": \"pnpm@<exact version>\""
fi

IMAGE_HASH="$({
  cat "$IMG_DIR/Dockerfile" "$IMG_DIR/entrypoint.sh"
  printf 'pnpm@%s\n' "$PNPM_VERSION"
  printf 'playwright@%s\n' "$PLAYWRIGHT_VERSION"
} | sha256_stdin | cut -c1-16)"
IMAGE="couli-verify:$IMAGE_HASH"
LOCK_HASH="$(sha256_stdin <"$SRC/pnpm-lock.yaml" | cut -c1-16)"
STORE_VOL="$PREFIX-store-$LOCK_HASH"
TAG="$(printf '%s' "$ID" | tr '[:upper:]' '[:lower:]')-$N-$$"
NET="$PREFIX-net-$TAG"
PG_NAME="$PREFIX-pg-$TAG"
REDIS_NAME="$PREFIX-redis-$TAG"
VERIFY_NAME="$PREFIX-run-$TAG"
RED_DB_NAME="$PREFIX-run-db-$TAG"
FETCH_NAME="$PREFIX-fetch-$TAG"
STORE_LOCK="$RUNS/lock/verify-store-$LOCK_HASH"
LABELS=(--label "couli.verify=1" --label "couli.task=$ID")
HARDEN=(--init --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096)
TMPFS=(--tmpfs "/work:rw,exec,nosuid,uid=1000,gid=1000,mode=0755" --tmpfs "/tmp:rw,exec,nosuid,uid=1000,gid=1000,mode=1777")

net_created=0
store_locked=0
ext_locked=0
EXT_RESET_NAME="$PREFIX-reset-$TAG"
EXT_LOCK="$RUNS/lock/verify-external-services"
EXT_PROXY="$VDIR/services-proxy.cjs"
cleanup() {
  # Signals do not reach processes inside a container: remove them explicitly.
  docker rm -f -v "$VERIFY_NAME" "$RED_DB_NAME" "$FETCH_NAME" "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  if [ "$net_created" -eq 1 ]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
  if [ "$store_locked" -eq 1 ]; then rmdir "$STORE_LOCK" 2>/dev/null || true; fi
  if [ "$ext_locked" -eq 1 ]; then
    docker rm -f "$EXT_RESET_NAME" >/dev/null 2>&1 || true
    # What this run left on the shared cluster goes before the next run may start.
    ext_reset after || log "verify-container: could not clean the external services after the run, see $LOG"
    rm -rf "$EXT_LOCK"
  fi
  if [ "$EXT_SERVICES" = 1 ]; then rm -f "$EXT_PROXY"; fi
  rm -rf "$SRC"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step() {
  log "verify-container: $*"
  printf '[verify-container %s] %s\n' "$(now_utc)" "$*" >>"$LOG"
}

# The one-shot services of a run that may connect to databases (ADR-0001 §4.2 #9): PostgreSQL
# (random password) and Redis, attached only to the run's --internal network, no published
# port, data on tmpfs. Exports TEST_PG_ADMIN_URL and TEST_REDIS_URL for `docker run -e NAME`.
# Redis runs with the settings of infra/local/compose.yaml: no RDB, no AOF, noeviction with an
# explicit limit (ADR-0001 §4.2 #17). It has no password: the network is internal and holds
# nothing but this run.
pg_ready() {
  # TCP only: the image first runs a temporary server that listens on the socket alone.
  docker exec "$PG_NAME" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1
}
redis_ready() {
  # The reply, not the exit code: a LOADING error reply is not ready.
  [ "$(docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null)" = PONG ]
}
wait_ready() { # <container> <readiness check> <label>
  local tries=0
  until "$2"; do
    # A container that has exited will never answer: stop now instead of waiting 60 seconds.
    if [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != true ]; then
      docker logs "$1" >>"$LOG" 2>&1 || true
      die "$3 exited before it became ready, see $LOG"
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      docker logs "$1" >>"$LOG" 2>&1 || true
      die "$3 did not become ready within 60 seconds, see $LOG"
    fi
    sleep 0.5
  done
}
start_services() { # <what the services are for, for the log>
  step "creating internal network $NET ($1)"
  docker network create --internal "${LABELS[@]}" "$NET" >/dev/null 2>>"$LOG" ||
    die "cannot create network $NET, see $LOG"
  net_created=1

  step "starting one-shot PostgreSQL ($PG_IMAGE) on $NET only"
  PG_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  POSTGRES_PASSWORD="$PG_PASSWORD" docker run -d --name "$PG_NAME" "${LABELS[@]}" \
    --network "$NET" --network-alias pg \
    --tmpfs /var/lib/postgresql \
    -e POSTGRES_PASSWORD \
    "$PG_IMAGE" >/dev/null 2>>"$LOG" || die "cannot start PostgreSQL, see $LOG"

  step "starting one-shot Redis ($REDIS_IMAGE) on $NET only"
  docker run -d --name "$REDIS_NAME" "${LABELS[@]}" \
    --network "$NET" --network-alias redis \
    --tmpfs /data \
    "$REDIS_IMAGE" redis-server --save '' --appendonly no \
    --maxmemory 256mb --maxmemory-policy noeviction >/dev/null 2>>"$LOG" ||
    die "cannot start Redis, see $LOG"

  # Both start in parallel; the run begins once both answer.
  wait_ready "$PG_NAME" pg_ready PostgreSQL
  wait_ready "$REDIS_NAME" redis_ready Redis
  export TEST_PG_ADMIN_URL="postgres://postgres:$PG_PASSWORD@pg:5432/postgres"
  export TEST_REDIS_URL='redis://redis:6379/0'
}

# --- external services (header: COULI_VERIFY_PG_SOCKET_DIR …) ---------------------------------
# The database container's network, mounts and command prefix. Empty unless external services
# are on: then `--network none`, the two socket directories read-only, the proxy, and a wrapper
# that starts the proxy and waits for it before it execs the entrypoint.
EXT_RUN=()
EXT_WRAP=()
IFS= read -r -d '' EXT_PROXY_JS <<'JS' || true
'use strict';
// Socket proxy of verify-container.sh (external services): the container has no network, the
// clients take host:port URLs only, so 127.0.0.1:<port> is forwarded to the mounted sockets.
const fs = require('node:fs');
const net = require('node:net');
const routes = JSON.parse(process.env.COULI_SERVICES_ROUTES);
let listening = 0;
for (const [port, path] of routes) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ path });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.end());
    upstream.on('close', () => client.end());
  });
  server.on('error', (error) => {
    process.stderr.write(`[services] cannot listen on 127.0.0.1:${port}: ${error.code}\n`);
    process.exit(2);
  });
  server.listen(port, '127.0.0.1', () => {
    listening += 1;
    if (listening === routes.length) fs.writeFileSync('/tmp/.couli-services-ready', '');
  });
}
JS
IFS= read -r -d '' EXT_WRAP_SH <<'SH' || true
node /couli-services/proxy.cjs &
proxy=$!
tries=0
until [ -e /tmp/.couli-services-ready ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 200 ] || ! kill -0 "$proxy" 2>/dev/null; then
    echo "[services] the socket proxy did not start" >&2
    exit 2
  fi
  sleep 0.05
done
exec "$@"
SH
# Drops what test runs create on the shared cluster (the clone, template and snapshot databases
# and the factory roles of packages/db/src/testing; the bootstrap roles stay) and empties Redis.
# Runs psql and node of the verify image, no network, the sockets mounted read-only.
IFS= read -r -d '' EXT_RESET_SH <<'SH' || true
set -euo pipefail
psql -X -q -At -v ON_ERROR_STOP=1 -v "phase=$RESET_PHASE" <<'SQL'
SELECT format('[services] %s: %s leftover test databases, %s leftover factory roles', :'phase',
  (SELECT count(*) FROM pg_database WHERE datname ~ '^couli_(tpl|snap|t)_[0-9a-f]{8}'),
  (SELECT count(*) FROM pg_roles WHERE rolname ~ '^couli_factory_[0-9a-f]{8}$'));
SELECT format('ALTER DATABASE %I WITH is_template false', datname) FROM pg_database
  WHERE datname ~ '^couli_(tpl|snap|t)_[0-9a-f]{8}' AND datistemplate \gexec
SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database
  WHERE datname ~ '^couli_(tpl|snap|t)_[0-9a-f]{8}' \gexec
SELECT format('DROP ROLE %I', rolname) FROM pg_roles
  WHERE rolname ~ '^couli_factory_[0-9a-f]{8}$' \gexec
SQL
# Test databases are created from template1: it must be as bare as the one-shot image's (only
# plpgsql, nothing in public), or every test database and the db:check snapshot inherit extra
# objects (Pigsty fills template1 with extensions and a monitor schema).
extra="$(psql -X -q -At -v ON_ERROR_STOP=1 -d template1 -c "SELECT
  (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') +
  (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema')) +
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')")"
if [ "$extra" != 0 ]; then
  echo "[services] template1 of the external PostgreSQL holds $extra extra extensions, schemas or relations: rebuild it from template0" >&2
  exit 1
fi
node -e '
  const s = require("node:net").connect({ path: process.env.REDIS_SOCK });
  let reply = "";
  const fail = (why) => { process.stderr.write(`[services] Redis: ${why}\n`); process.exit(1); };
  setTimeout(() => fail("no answer within 10 seconds"), 10000).unref();
  s.on("connect", () => s.write("*1\r\n$8\r\nFLUSHALL\r\n"));
  s.on("error", (e) => fail(e.code));
  s.on("data", (d) => {
    reply += d;
    if (!reply.includes("\r\n")) return;
    if (reply.startsWith("+OK")) { process.stdout.write("[services] Redis emptied\n"); process.exit(0); }
    fail(reply.split("\r\n")[0]);
  });
'
SH
ext_reset() { # <before|after>
  [ "${IMAGE:-}" != '' ] || return 0
  PGPASSWORD="$EXT_PG_PASSWORD" docker run --rm --name "$EXT_RESET_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
    --network none \
    -v "$EXT_PG_DIR:/run/couli-pg:ro" \
    -v "$EXT_REDIS_DIR:/run/couli-redis:ro" \
    -e PGPASSWORD -e PGHOST=/run/couli-pg -e "PGPORT=$EXT_PG_PORT" -e "PGUSER=$EXT_PG_USER" \
    -e PGDATABASE=postgres -e "RESET_PHASE=$1" -e "REDIS_SOCK=/run/couli-redis/$EXT_REDIS_BASE" \
    "$IMAGE" bash -c "$EXT_RESET_SH" >>"$LOG" 2>&1 </dev/null
}
ext_lock() {
  # One run on the shared cluster at a time: the cleanup drops every test database by prefix.
  mkdir -p "$RUNS/lock"
  local waited=0 owner
  while ! mkdir "$EXT_LOCK" 2>/dev/null; do
    owner="$(cat "$EXT_LOCK/pid" 2>/dev/null || true)"
    if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
      step "taking over the stale lock $EXT_LOCK of process $owner"
      rm -rf "$EXT_LOCK"
      continue
    fi
    [ "$waited" -lt 3600 ] || die "another run holds $EXT_LOCK for more than an hour"
    sleep 5
    waited=$((waited + 5))
  done
  printf '%s\n' "$$" >"$EXT_LOCK/pid"
  ext_locked=1
}
start_external_services() { # <what the services are for, for the log>
  # Existence only: the cleanup below connects to both before the run starts.
  [ -e "$EXT_PG_DIR/.s.PGSQL.$EXT_PG_PORT" ] || die "no PostgreSQL socket $EXT_PG_DIR/.s.PGSQL.$EXT_PG_PORT"
  [ -e "$EXT_REDIS_SOCKET" ] || die "no Redis socket $EXT_REDIS_SOCKET"
  [ -r "$EXT_PG_PWFILE" ] || die "cannot read COULI_VERIFY_PG_ADMIN_PASSWORD_FILE"
  EXT_PG_PASSWORD="$(head -n 1 "$EXT_PG_PWFILE" | tr -d '\r')"
  [ -n "$EXT_PG_PASSWORD" ] || die "COULI_VERIFY_PG_ADMIN_PASSWORD_FILE is empty"
  step "waiting for the external-services lock $EXT_LOCK ($1)"
  ext_lock
  step "cleaning the external PostgreSQL ($EXT_PG_DIR, port $EXT_PG_PORT) and Redis ($EXT_REDIS_SOCKET) before the run"
  ext_reset before || die "cannot reach or clean the external PostgreSQL / Redis, see $LOG"
  printf '%s' "$EXT_PROXY_JS" >"$EXT_PROXY"
  chmod 0644 "$EXT_PROXY"
  EXT_RUN=(--network none
    -v "$EXT_PG_DIR:/run/couli-pg:ro"
    -v "$EXT_REDIS_DIR:/run/couli-redis:ro"
    -v "$EXT_PROXY:/couli-services/proxy.cjs:ro"
    -e "COULI_SERVICES_ROUTES=[[5432,\"/run/couli-pg/.s.PGSQL.$EXT_PG_PORT\"],[6379,\"/run/couli-redis/$EXT_REDIS_BASE\"]]")
  EXT_WRAP=(bash -c "$EXT_WRAP_SH" couli-services)
  local enc
  enc="$(EXT_PG_PASSWORD="$EXT_PG_PASSWORD" node -e 'process.stdout.write(encodeURIComponent(process.env.EXT_PG_PASSWORD))')"
  export TEST_PG_ADMIN_URL="postgres://$EXT_PG_USER:$enc@127.0.0.1:5432/postgres"
  export TEST_REDIS_URL='redis://127.0.0.1:6379/0'
  SERVICES_FIELD=$',\n  "services": "external"'
  step "external services ready: the run gets 127.0.0.1:5432 and 127.0.0.1:6379 through the socket proxy, no network"
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  step "building image $IMAGE (pnpm $PNPM_VERSION, playwright $PLAYWRIGHT_VERSION)"
  docker build -t "$IMAGE" --build-arg "PNPM_VERSION=$PNPM_VERSION" \
    --build-arg "PLAYWRIGHT_VERSION=$PLAYWRIGHT_VERSION" --label "couli.verify=1" "$IMG_DIR" >>"$LOG" 2>&1 ||
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
  # Groups of the plan (tools/ops/red-plan.ts), split by the project's `database` flag into at
  # most two containers (Codex review of F1-01j, S1): the groups that need PostgreSQL run in one
  # with the one-shot PostgreSQL and Redis on the internal network; every other group (unit,
  # browser) runs in another with no network at all and no database URL — also when the same task
  # adds both kinds of rule tests.
  printf '%s\n' "$RED_FILES" >"$VDIR/expected.txt"
  printf '%s\n' "$RED_PLAN" >"$VDIR/plan.json"
  mkdir -p "$VDIR/out"
  chmod 0777 "$VDIR/out"
  red_part() { # <1: groups with a database, 0: the others>; prints the plan of those groups or ''
    node -e '
      const want = process.argv[2] === "1";
      const groups = JSON.parse(process.argv[1]).groups.filter((g) => g.database === want);
      if (groups.length > 0) process.stdout.write(JSON.stringify({ groups }));
    ' "$RED_PLAN" "$1"
  }
  red_container() { # <container name> <plan> <1: database network, 0: no network>
    local env=(-e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS" -e RED_PLAN)
    [ -z "${PROP_RUNS:-}" ] || env+=(-e "PROP_RUNS=$PROP_RUNS")
    local net=(--network none)
    local wrap=()
    if [ "$3" = 1 ]; then
      net=(--network "$NET")
      env+=(-e TEST_PG_ADMIN_URL -e TEST_REDIS_URL)
      if [ "$EXT_SERVICES" = 1 ]; then
        net=("${EXT_RUN[@]}")
        wrap=("${EXT_WRAP[@]}")
      fi
    fi
    local red_rc=0
    RED_PLAN="$2" docker run --rm --name "$1" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
      "${net[@]}" \
      -v "$SRC:/src:ro" \
      -v "$STORE_VOL:/store:ro" \
      -v "$VDIR/out:/out" \
      -v "$IMG_DIR/red-reporter.mjs:/red/red-reporter.mjs:ro" \
      --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
      ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
      "${env[@]}" \
      "$IMAGE" ${wrap[@]+"${wrap[@]}"} couli-verify-entrypoint red >>"$LOG" 2>&1 </dev/null || red_rc=$?
    [ "$red_rc" = 0 ] || die "the red run did not produce its reports (exit $red_rc), see $LOG"
  }
  red_db_plan="$(red_part 1)"
  red_offline_plan="$(red_part 0)"
  if [ -n "$red_db_plan" ]; then
    if [ "$EXT_SERVICES" = 1 ]; then
      start_external_services 'integration rule tests'
      step "running the task's integration rule tests (red run) in $IMAGE, no network, external services (limit ${TIMEOUT_SECS}s)"
    else
      start_services 'integration rule tests'
      step "running the task's integration rule tests (red run) in $IMAGE on $NET (limit ${TIMEOUT_SECS}s)"
    fi
    red_container "$RED_DB_NAME" "$red_db_plan" 1
  fi
  if [ -n "$red_offline_plan" ]; then
    step "running the task's other rule tests (red run) in $IMAGE, no network (limit ${TIMEOUT_SECS}s)"
    red_container "$VERIFY_NAME" "$red_offline_plan" 0
  fi
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

if [ "$SCRIPT" = browser ]; then
  # The browser projects only, no network at all: Vitest serves the browser tests and Chromium
  # loads them on the container's loopback; the build smoke serves its builds there too. The
  # output directory takes the screenshots and the reports.
  # The container runs as uid 1000 (node), which is not the owner of the directory on a Linux
  # host: it needs write and search permission as "other". 1733 gives it exactly that (no
  # listing, and the sticky bit keeps it from removing what it did not create); the owner keeps
  # full access to read the results.
  mkdir -p "$VDIR/out"
  chmod 1733 "$VDIR/out"
  step "running the browser tests ($BROWSER_PROJECTS) in $IMAGE (no network, limit ${TIMEOUT_SECS}s)"
  BROWSER_ENV=(-e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS"
    -e "BROWSER_PROJECTS=$BROWSER_PROJECTS")
  [ -z "${PROP_RUNS:-}" ] || BROWSER_ENV+=(-e "PROP_RUNS=$PROP_RUNS")
  rc=0
  docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
    --network none \
    -v "$SRC:/src:ro" \
    -v "$STORE_VOL:/store:ro" \
    -v "$VDIR/out:/out" \
    --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
    "${BROWSER_ENV[@]}" \
    "$IMAGE" couli-verify-entrypoint browser >>"$LOG" 2>&1 </dev/null || rc=$?
  # The run exists to export screenshots for the design comparison: a green run that exported
  # none (no test called page.screenshot, or the export directory was not used) fails.
  shots="$( (find "$VDIR/out/screenshots" -type f -name '*.png' 2>/dev/null || true) | wc -l | tr -d ' ')"
  # The build smoke writes smoke-<entry>.png at the top of the directory; Vitest browser mode
  # writes below a directory per test file.
  smoke_shots="$( (find "$VDIR/out/screenshots" -maxdepth 1 -type f -name 'smoke-*.png' 2>/dev/null || true) | wc -l | tr -d ' ')"
  step "browser tests exited $rc; screenshots exported: $shots (browser tests $((shots - smoke_shots)), build smoke $smoke_shots; $VDIR/out/screenshots)"
  if [ "$rc" = 0 ] && [ "$shots" = 0 ]; then
    step "no screenshot was exported to out/screenshots: the browser run counts as failed (exit 1)"
    log "verify-container: no screenshot was exported to $VDIR/out/screenshots"
    rc=1
  fi
  finish "$rc"
fi

if [ "$SCRIPT" = 'verify:fast' ]; then
  # verify:fast connects to no database and no network (规划/11 §4.1): no PostgreSQL, no
  # Redis, no network at all.
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

VERIFY_NET=(--network "$NET")
if [ "$EXT_SERVICES" = 1 ]; then
  start_external_services 'pnpm verify'
  VERIFY_NET=("${EXT_RUN[@]}")
else
  start_services 'pnpm verify'
fi

step "running pnpm verify in $IMAGE (limit ${TIMEOUT_SECS}s)"
ENV_ARGS=(-e TEST_PG_ADMIN_URL -e TEST_REDIS_URL
  -e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS")
[ -z "${PROP_RUNS:-}" ] || ENV_ARGS+=(-e "PROP_RUNS=$PROP_RUNS")
rc=0
docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
  "${VERIFY_NET[@]}" \
  -v "$SRC:/src:ro" \
  -v "$STORE_VOL:/store:ro" \
  --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
  ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
  "${ENV_ARGS[@]}" \
  "$IMAGE" ${EXT_WRAP[@]+"${EXT_WRAP[@]}"} couli-verify-entrypoint verify >>"$LOG" 2>&1 </dev/null || rc=$?

finish "$rc"
