# Shared functions of the tools/agent bash scripts. Sourced, never executed.
# Expects SELF_REPO (physical path of the checkout that contains the calling script).
# Works with macOS bash 3.2 and Linux bash.

# Variables git sets while running hooks would redirect every `git -C <dir>` below (and Codex's
# own git commands) to another repository; never inherit them (same list as tools/lib/git.ts).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES

# Same shape as TASK_ID_PATTERN in tools/lib/task-file.ts.
AGENT_TASK_ID_PATTERN='^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$'

agent_valid_task_id() {
  [ "${#1}" -le 64 ] && [[ "$1" =~ $AGENT_TASK_ID_PATTERN ]]
}

agent_now_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Sets RUNS, SPEC_REPO and TRUSTED (conventions C7; same rules as tools/lib/paths.ts):
#   RUNS      COULI_RUNS, default <REPO>/../couli-runs; a checkout that itself lives in
#             <runs>/trusted/ or <runs>/worktrees/ uses that <runs>.
#   SPEC_REPO COULI_SPEC_REPO, default the sibling `couli` checkout.
#   TRUSTED   COULI_TRUSTED_ROOT, else <runs>/trusted/rebate-platform once it exists, else REPO.
agent_resolve_roots() {
  local parent projects
  parent="$(dirname "$SELF_REPO")"
  case "$(basename "$parent")" in
    trusted | worktrees)
      RUNS="$(dirname "$parent")"
      projects="$(dirname "$RUNS")"
      ;;
    *)
      RUNS="$parent/couli-runs"
      projects="$parent"
      ;;
  esac
  if [ -n "${COULI_RUNS:-}" ]; then RUNS="$COULI_RUNS"; fi
  case "$RUNS" in
    /*) ;;
    *) RUNS="$PWD/$RUNS" ;;
  esac
  SPEC_REPO="${COULI_SPEC_REPO:-$projects/couli}"
  if [ -n "${COULI_TRUSTED_ROOT:-}" ]; then
    TRUSTED="$COULI_TRUSTED_ROOT"
    if agent_is_task_worktree "$TRUSTED"; then
      printf 'COULI_TRUSTED_ROOT points into a task worktree: %s (规划/11 §2.4: gates are never read from the branch under test)\n' "$TRUSTED" >&2
      return 1
    fi
  elif [ -d "$RUNS/trusted/rebate-platform/tools/guard" ]; then
    TRUSTED="$RUNS/trusted/rebate-platform"
  elif agent_is_task_worktree "$SELF_REPO"; then
    # Same rule as trustedRoot() in tools/lib/paths.ts: a task worktree is the sandbox's
    # writable root and can never be the source of its own guards, schemas or prompts.
    printf 'refusing to run from the task worktree %s: use the main checkout or the trusted copy, or set COULI_TRUSTED_ROOT (规划/11 §2.4)\n' "$SELF_REPO" >&2
    return 1
  else
    TRUSTED="$SELF_REPO"
  fi
  if [ ! -d "$TRUSTED/tools/agent/schemas" ]; then
    printf 'trusted root has no tools/agent/schemas: %s\n' "$TRUSTED" >&2
    return 1
  fi
  TRUSTED="$(cd "$TRUSTED" && pwd -P)"
}

# True when $1 lies inside a task worktree: under $RUNS/worktrees/<id>, or a path of the shape
# .../couli-runs/worktrees/<id>[/...] (recognised even when COULI_RUNS points elsewhere).
agent_is_task_worktree() {
  local path="$1" worktrees="${RUNS%/}/worktrees"
  case "$path/" in
    "$worktrees"/?*) return 0 ;;
  esac
  case "$path/" in
    */couli-runs/worktrees/?*) return 0 ;;
  esac
  return 1
}

# True when task $2 is a ledger listed in <trusted $1>/tools/guard/legacy-tasks.json (written
# before the default split of 2026-10-05 was merged; it keeps the old flow). A missing or broken
# list lists nothing.
agent_task_is_legacy() {
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(Array.isArray(doc.tasks) && doc.tasks.includes(process.argv[2]) ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$1/tools/guard/legacy-tasks.json" "$2"
}

# True while any process of the process group $1 exists.
agent_group_alive() {
  perl -e 'exit((kill(0, -$ARGV[0]) || $!{EPERM}) ? 0 : 1)' "$1"
}

# TERM to the whole group, wait up to $2 seconds, then KILL the whole group (规划/11 §2.4).
agent_kill_group() {
  perl -e '
    my ($pgid, $grace) = @ARGV;
    kill("TERM", -$pgid);
    my $deadline = time + $grace;
    while (time < $deadline && (kill(0, -$pgid) || $!{EPERM})) { select(undef, undef, undef, 0.1); }
    kill("KILL", -$pgid);
    my $gone = time + 10;
    while (time < $gone && (kill(0, -$pgid) || $!{EPERM})) { select(undef, undef, undef, 0.1); }
  ' "$1" "$2"
}
