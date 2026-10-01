#!/usr/bin/env bash
# post-run.sh <id> — what happens after an implementation run (规划/11 §2.3 step 6, §2.5).
#
# Requires the Codex process group of the run to be gone, reads RUN/meta.impl.json, runs the
# path guard and the protected-path guard FROM THE TRUSTED ROOT before anything of the worktree
# is executed (先守卫、后执行), and prints one JSON line with the next action:
#   verify          hand over to tools/ops/verify-container.sh <id>
#   retry           failed attempt; re-dispatch after backoff_min (15 / 30 / 60 by attempt)
#   blocked         attempts used up, position assertion failed, dependencies needed, …
#   ask             the change touches protected paths of class 2 or 3 (owner decides)
#   capacity-retry  model capacity error; retried, not counted in attempts
#   none            the run has not finished yet (exit code 1)
#
# This script never runs code of the task, never installs anything and never changes git state
# or the worktree. Its only side effect outside RUN/post-run/ is ending an orphaned Codex
# process group whose wrapper has died.
#
# Exit codes: 0 an action was decided | 1 the run is still in progress | 2 usage or internal error.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF_REPO="$(cd "$SELF_DIR/../.." && pwd -P)"
# shellcheck source=tools/agent/common.sh
. "$SELF_DIR/common.sh"
export GIT_OPTIONAL_LOCKS=0

log() { printf 'post-run: %s\n' "$*" >&2; }
emit() { node "$SELF_DIR/meta.ts" emit "$@"; }
meta_get() { node "$SELF_DIR/meta.ts" get --file "$1" "$2"; }

if [ $# -ne 1 ]; then
  log "usage: post-run.sh <id>"
  exit 2
fi
TASK="$1"
agent_valid_task_id "$TASK" || {
  log "invalid task id: $TASK"
  exit 2
}
for tool in node perl git; do
  command -v "$tool" >/dev/null 2>&1 || {
    log "required tool not found: $tool"
    exit 2
  }
done
agent_resolve_roots || exit 2

OPS="$TRUSTED/tools/ops"
GUARD="$TRUSTED/tools/guard"
RUN="$RUNS/$TASK"
[ -d "$RUN" ] || {
  log "no run directory: $RUN"
  exit 2
}
RUN="$(cd "$RUN" && pwd -P)"
META="$RUN/meta.impl.json"
PGID_FILE="$RUN/wrapper-impl/pgid"
GRACE_SECS="${COULI_KILL_GRACE_SECS:-5}"
WORK="$RUN/post-run"
mkdir -p "$WORK"

# In-flight state: attempts already used (this run included), rule-test commit, launcher pid.
attempts=0
spec_commit=''
state_pid=''
if node "$OPS/state.ts" get "$TASK" >"$WORK/state.json" 2>/dev/null; then
  attempts="$(meta_get "$WORK/state.json" attempts.impl)"
  spec_commit="$(meta_get "$WORK/state.json" spec_commit)"
  state_pid="$(meta_get "$WORK/state.json" pid)"
fi
case "$attempts" in
  '' | *[!0-9]*) attempts=0 ;;
esac

pid_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

still_running() {
  emit --str action=none --str "task=$TASK" --str "run=$RUN" --str "reason=$1"
  exit 1
}

finished=''
wrapper_pid=''
if [ -f "$META" ]; then
  finished="$(meta_get "$META" finished_at)"
  wrapper_pid="$(meta_get "$META" wrapper_pid)"
fi

if [ -z "$finished" ]; then
  # Not finished: either still running, or the wrapper died.
  if pid_alive "$wrapper_pid" || { [ ! -f "$META" ] && pid_alive "$state_pid"; }; then
    still_running wrapper-running
  fi
  if [ -f "$PGID_FILE" ]; then
    pgid="$(head -n 1 "$PGID_FILE" | tr -cd '0-9')"
    if [ -n "$pgid" ] && agent_group_alive "$pgid"; then
      log "wrapper is gone but Codex process group $pgid is alive: ending the whole group"
      agent_kill_group "$pgid" "$GRACE_SECS"
      if agent_group_alive "$pgid"; then still_running codex-group-alive; fi
    fi
  fi
  detail=''
  if [ -f "$RUN/dispatch.log" ]; then detail="$(tail -n 1 "$RUN/dispatch.log")"; fi
  if [ ! -f "$META" ]; then
    # The wrapper stopped before it started Codex (usage error, position assertion, …).
    emit --str action=blocked --str "task=$TASK" --str "run=$RUN" --str reason=wrapper-failed \
      --num "attempt=$attempts" --str "detail=$detail"
    exit 0
  fi
  # The wrapper died without finishing meta.json: an orphan. Its attempt was counted before
  # the launch (规划/11 §2.5: 孤儿算一次).
  node "$SELF_DIR/next-action.ts" --task "$TASK" --run "$RUN" --attempts "$attempts" \
    --failure orphan --detail "$detail"
  exit 0
fi

# Finished. The process group must be gone before the output is trusted.
pgid="$(meta_get "$META" pgid)"
if [ "$(meta_get "$META" group_gone)" != true ]; then
  if [ -n "$pgid" ] && [ "$pgid" != 0 ] && agent_group_alive "$pgid"; then
    still_running codex-group-alive
  fi
fi

exit_code="$(meta_get "$META" exit_code)"
decide=(--task "$TASK" --run "$RUN" --meta "$META" --attempts "$attempts")

if [ "$exit_code" = 0 ]; then
  WT="$(meta_get "$META" worktree)"
  [ -d "$WT" ] || {
    log "worktree recorded in meta.json not found: $WT"
    exit 2
  }
  # Base of the guards: the rule-test commit when there is one, else the branch point.
  base="$spec_commit"
  if [ -z "$base" ]; then
    for candidate in origin/main main; do
      if git -C "$WT" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
        base="$(git -C "$WT" merge-base HEAD "$candidate" || true)"
        [ -z "$base" ] || break
      fi
    done
  fi
  if [ -z "$base" ]; then base="$(meta_get "$META" head_before)"; fi

  for script in path-guard.ts protected-paths.ts; do
    [ -f "$GUARD/$script" ] || {
      log "missing in the trusted root: tools/guard/$script (no guard, no next step)"
      exit 2
    }
  done
  task_type=''
  if [ -f "$OPS/task.ts" ] && node "$OPS/task.ts" show "$TASK" --json >"$WORK/task.json" 2>/dev/null; then
    task_type="$(meta_get "$WORK/task.json" type)"
  fi

  # Guards run from the trusted root with the worktree as data (--cwd); nothing of the
  # worktree is executed.
  pg_rc=0
  (cd "$TRUSTED" && node "$GUARD/path-guard.ts" --task "$TASK" --base "$base" --cwd "$WT" --json) \
    >"$WORK/path-guard.json" 2>"$WORK/path-guard.err" || pg_rc=$?
  pp_args=(--base "$base" --cwd "$WT" --json)
  if [ -n "$task_type" ]; then pp_args+=(--task-type "$task_type"); fi
  pp_rc=0
  (cd "$TRUSTED" && node "$GUARD/protected-paths.ts" "${pp_args[@]}") \
    >"$WORK/protected-paths.json" 2>"$WORK/protected-paths.err" || pp_rc=$?

  decide+=(--base "$base" --impl "$RUN/impl.json"
    --path-guard "$WORK/path-guard.json" --path-guard-exit "$pg_rc"
    --protected "$WORK/protected-paths.json" --protected-exit "$pp_rc")
fi

node "$SELF_DIR/next-action.ts" "${decide[@]}"
