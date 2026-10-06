#!/usr/bin/env bash
# dispatch.sh <id> [--handover] — preflight and background launch of one Codex run in impl mode
# (规划/11 §2.2 后台运行, §2.3 steps 3 and 5, §2.5).
#
# Default split since 2026-10-05 (ops/approvals.yaml id 19): Claude Opus 5.5 implements (a
# subagent the orchestrator starts, README §10, not this script), Codex writes the rule tests.
# So this script launches one of two Codex runs:
#   (default)    test phase: Codex writes red rule tests and NotImplemented skeletons. Refused
#                once the task has a spec_commit (the rule tests are committed and frozen).
#   --handover   Codex implements once after the Opus attempts ran out (规划/11 §2.5 超限换家);
#                RV0 / RV1 only, checked here with the trusted task.ts and again by codex-run.sh.
#   (legacy)     a ledger on tools/guard/legacy-tasks.json with impl: codex keeps the old flow:
#                the default dispatch is Codex's implementation (phase impl), after Claude's
#                rule tests. The same for a task of tools/guard/codex-impl-tasks.json with
#                impl: codex, tester: claude (ops/approvals.yaml id 23), once spec_commit is set.
# The phase picks the counter (state.ts bump-attempt test|handover|impl), the brief
# (brief.ts --phase test|handover|impl) and the wrapper phase (codex-run.sh impl --phase …).
#
# There is no quota gate: the owner said on 2026-10-02 that the Codex quota is unlimited
# (ops/approvals.yaml id 15). Only failures stop a task (§2.5), checked in step 2.
#
# Preflight, in this order; the first failure stops everything:
#   1. claim               node <TRUSTED>/tools/ops/state.ts claim <id> --owner <session>
#                          The owner is COULI_SESSION when set, else a name unique to this
#                          dispatch process; `--renew` is tried only when the claim on file is
#                          already held by this very owner (never for another session's claim)
#   2. count the attempt   node <TRUSTED>/tools/ops/state.ts bump-attempt <id> test|handover
#                          BEFORE launching, every time. A call that ends without output
#                          (timeout, capacity error, no `-o`, …) is given back by codex-run.sh
#                          (state.ts settle) when it finishes (§2.5). bump-attempt exits 3 when a
#                          failure breaker of the task is open (10 calls, or 3 calls in a row
#                          without output): the task is stopped and reported
#   3. task brief          RUN/brief.md when it is a brief of this phase (its `- 本轮阶段：`
#                          line), else node <TRUSTED>/tools/ops/brief.ts <id> --phase <p>. From
#                          the second attempt on the brief is always regenerated: every round is
#                          a new one and carries the previous failure output (§2.3 重试不用 resume)
#   4. worktree            <runs>/worktrees/<id> exists and has node_modules. Dependencies are
#                          installed by the orchestrator outside the sandbox; nothing is
#                          installed here.
# Then codex-run.sh impl <id> --phase <test|handover> is started in the background in its own
# session (under `caffeinate -i` when available), pid and start time are recorded with
# state.ts set, and one JSON line is printed:
# {"action":"dispatched","pid":<n>,"run":"<RUN>","phase":"test|handover"}.
#
# Exit codes: 0 dispatched | 3 a failure breaker of the task is open | 1 a preflight check
#             failed | 2 usage or internal error. On every non-zero exit one JSON line with
#             "action":"stopped" (breaker) or "action":"none" says why.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF_REPO="$(cd "$SELF_DIR/../.." && pwd -P)"
# shellcheck source=tools/agent/common.sh
. "$SELF_DIR/common.sh"

log() { printf 'dispatch: %s\n' "$*" >&2; }
emit() { node "$SELF_DIR/meta.ts" emit "$@"; }

HANDOVER=0
if [ $# -eq 2 ] && [ "$2" = --handover ]; then
  HANDOVER=1
elif [ $# -ne 1 ]; then
  log "usage: dispatch.sh <id> [--handover]"
  exit 2
fi
TASK="$1"
agent_valid_task_id "$TASK" || {
  log "invalid task id: $TASK"
  exit 2
}
for tool in node perl; do
  command -v "$tool" >/dev/null 2>&1 || {
    log "required tool not found: $tool"
    exit 2
  }
done
agent_resolve_roots || exit 2

OPS="$TRUSTED/tools/ops"
RUN="$RUNS/$TASK"
WT="$RUNS/worktrees/$TASK"
if [ "$HANDOVER" = 1 ]; then
  PHASE=handover
  BRIEF_PHASE=handover
else
  PHASE=test
  BRIEF_PHASE=test
fi
for script in state.ts brief.ts; do
  [ -f "$OPS/$script" ] || {
    log "missing in the trusted root: tools/ops/$script"
    exit 2
  }
done

stop() { # stop <exit code> <reason> [detail]
  emit --str action=none --str "task=$TASK" --str "reason=$2" --str "detail=${3:-}"
  exit "$1"
}

# Last line a failed CLI printed on stderr, for the JSON reason.
ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/couli-dispatch.XXXXXX")"
# One dispatch of a task at a time, from the first check to the recorded pid: `mkdir` is the
# atomic test-and-set. The lock lives only as long as this script.
mkdir -p "$RUN"
LAUNCH_LOCK="$RUN/dispatch.lock"
if ! mkdir "$LAUNCH_LOCK" 2>/dev/null; then
  lock_age="$(perl -e 'my @st = stat($ARGV[0]); print @st ? int(time - $st[9]) : -1' "$LAUNCH_LOCK")"
  if [ "$lock_age" -ge 0 ] && [ "$lock_age" -lt 600 ]; then
    emit --str action=none --str "task=$TASK" --str reason=dispatch-in-progress --str "detail=$LAUNCH_LOCK is ${lock_age}s old"
    rm -f "$ERR_FILE"
    exit 1
  fi
  # Older than 10 minutes: a dispatch that died without cleaning up.
  rmdir "$LAUNCH_LOCK" 2>/dev/null || true
  mkdir "$LAUNCH_LOCK" 2>/dev/null || {
    emit --str action=none --str "task=$TASK" --str reason=dispatch-in-progress --str "detail=$LAUNCH_LOCK"
    rm -f "$ERR_FILE"
    exit 1
  }
fi
trap 'rm -f "$ERR_FILE"; rmdir "$LAUNCH_LOCK" 2>/dev/null || true' EXIT
last_error() { tail -n 1 "$ERR_FILE" 2>/dev/null || true; }

# 1. Claim (规划/11 §2.2 领任务). Every orchestrator session has its own owner name, so a
# renewal can never ride on another session's claim. Without COULI_SESSION the name is unique
# to this process: a second dispatch of a task that is still claimed is refused instead.
OWNER="${COULI_SESSION:-orchestrator-$(hostname -s 2>/dev/null || echo host)-$$}"
case "$OWNER" in
  *[!A-Za-z0-9._-]* | '') stop 2 bad-owner "COULI_SESSION must match [A-Za-z0-9._-]+ (got $OWNER)" ;;
esac
if ! node "$OPS/state.ts" claim "$TASK" --owner "$OWNER" >/dev/null 2>"$ERR_FILE"; then
  claim_error="$(last_error)"
  held_by="$(node "$OPS/state.ts" get "$TASK" 2>/dev/null |
    node "$SELF_DIR/meta.ts" get --file /dev/stdin owner_session 2>/dev/null || true)"
  if [ -n "$held_by" ] && [ "$held_by" = "$OWNER" ]; then
    node "$OPS/state.ts" claim "$TASK" --renew --owner "$OWNER" >/dev/null 2>"$ERR_FILE" ||
      stop 1 claim-failed "$(last_error)"
  else
    stop 1 claim-failed "$claim_error"
  fi
fi

# A run of this task that is still alive (pid recorded by a previous dispatch) must not get a
# second implementation started next to it on the same worktree.
state_now="$(node "$OPS/state.ts" get "$TASK" 2>/dev/null || true)"
running_pid="$(printf '%s\n' "$state_now" |
  node "$SELF_DIR/meta.ts" get --file /dev/stdin pid 2>/dev/null || true)"
spec_commit_now="$(printf '%s\n' "$state_now" |
  node "$SELF_DIR/meta.ts" get --file /dev/stdin spec_commit 2>/dev/null || true)"
case "$running_pid" in
  '' | null | *[!0-9]*) ;;
  *)
    if kill -0 "$running_pid" 2>/dev/null; then
      stop 1 run-in-progress "pid $running_pid of a previous dispatch is still alive (run tools/agent/post-run.sh $TASK first)"
    fi
    ;;
esac

# Which run is this? The trusted ledger decides.
#   - a ledger on tools/guard/legacy-tasks.json that names Codex as implementer (impl: codex):
#     the old flow, Claude wrote the rule tests and Codex implements (phase impl, the
#     implementation counter, an implementation brief; no test_paths, no handover);
#   - otherwise the default split of 2026-10-05: Codex writes the rule tests once (phase test,
#     test_paths required unless the ledger is a legacy one), frozen after spec_commit; the
#     implementation belongs to the Opus subagent (README §10);
#   - --handover: Codex implements once, RV0 / RV1 only (规划/11 §2.5: RV2 stops instead).
[ -f "$OPS/task.ts" ] || {
  log "missing in the trusted root: tools/ops/task.ts"
  exit 2
}
task_json="$(node "$OPS/task.ts" show "$TASK" --json 2>/dev/null || true)"
task_field() {
  printf '%s\n' "$task_json" | node "$SELF_DIR/meta.ts" get --file /dev/stdin "$1" 2>/dev/null || true
}
legacy=0
if agent_task_is_legacy "$TRUSTED" "$TASK"; then legacy=1; fi
if [ "$PHASE" = handover ]; then
  task_risk="$(task_field risk)"
  case "$task_risk" in
    RV0 | RV1) ;;
    *) stop 1 handover-refused "task $TASK is ${task_risk:-of unknown risk}: a Codex handover implementation is for RV0 / RV1 only (规划/11 §2.5: RV2 stops)" ;;
  esac
elif [ "$legacy" = 1 ] && [ "$(task_field impl)" = codex ]; then
  PHASE=impl
  BRIEF_PHASE=impl
elif [ "$(task_field impl)" = codex ] && [ "$(task_field tester)" = claude ] &&
  agent_task_is_codex_impl "$TRUSTED" "$TASK"; then
  # Owner 2026-10-06 (ops/approvals.yaml id 23): Claude wrote the rule tests first; Codex
  # implements once they are committed and frozen (spec_commit recorded).
  case "$spec_commit_now" in
    '' | null) stop 1 spec-commit-missing "task $TASK is a Codex implementation (tools/guard/codex-impl-tasks.json): commit Claude's red rule tests and record spec_commit first (state.ts set --spec-commit)" ;;
  esac
  PHASE=impl
  BRIEF_PHASE=impl
else
  # CR-06: the test phase writes only into the task's test_paths; a ledger without them is not
  # dispatched (nothing is counted), unless it is a legacy ledger (old scope).
  test_paths_now="$(task_field test_paths)"
  if [ "$legacy" = 0 ]; then
    case "$test_paths_now" in
      '' | '[]' | null) stop 1 test-paths-missing "ops/tasks/$TASK.yaml has no test_paths: add the task's rule-test paths (inside class 1 of the protected paths) before the test phase" ;;
    esac
  fi
  case "$spec_commit_now" in
    '' | null) ;;
    *) stop 1 spec-commit-exists "rule tests are committed (spec_commit $spec_commit_now): the implementation goes to a Claude Opus subagent (tools/agent/README.md §10); a Codex handover is dispatch.sh $TASK --handover" ;;
  esac
fi

# 2. Count the attempt before anything is launched (规划/11 §2.5). A previous call that ended
# without output (capacity error included) was already given back by codex-run.sh. Exit 3: a
# failure breaker of this task is open (per-task call cap, consecutive calls without output).
bump_rc=0
node "$OPS/state.ts" bump-attempt "$TASK" "$PHASE" >/dev/null 2>"$ERR_FILE" || bump_rc=$?
if [ "$bump_rc" = 3 ]; then
  emit --str action=stopped --str "task=$TASK" --str reason=task-breaker \
    --str "detail=$(cat "$ERR_FILE" 2>/dev/null || true)"
  exit 3
fi
if [ "$bump_rc" = 1 ]; then stop 1 attempts-exhausted "$(last_error)"; fi
if [ "$bump_rc" != 0 ]; then stop 2 state-error "$(last_error)"; fi

# 3. Task brief. A first attempt uses the brief that is already there. Every later attempt gets
# a fresh one: brief.ts reads the attempt number and the previous failure output from the
# in-flight state, which the orchestrator updates between rounds (state.ts set --last-error).
attempts_now="$(node "$OPS/state.ts" get "$TASK" 2>/dev/null |
  node "$SELF_DIR/meta.ts" get --file /dev/stdin "attempts.$PHASE" 2>/dev/null || true)"
case "$attempts_now" in
  '' | *[!0-9]*) attempts_now=1 ;;
esac
# A brief written for another phase (brief.ts writes `- 本轮阶段：<phase>（…）`) is never reused:
# the test-phase brief lets Codex add rule tests, the impl brief freezes them.
brief_phase_ok=0
if [ -s "$RUN/brief.md" ] && grep -q "^- 本轮阶段：$BRIEF_PHASE（" "$RUN/brief.md"; then
  brief_phase_ok=1
fi
if [ "$brief_phase_ok" = 0 ] || [ "$attempts_now" -ge 2 ]; then
  mkdir -p "$RUN"
  node "$OPS/brief.ts" "$TASK" --phase "$BRIEF_PHASE" --out "$RUN/brief.md" >/dev/null 2>"$ERR_FILE" ||
    stop 1 brief-failed "$(last_error)"
  [ -s "$RUN/brief.md" ] || stop 1 brief-failed "brief.ts wrote no $RUN/brief.md"
fi

# 4. Worktree with dependencies already installed (never install here).
[ -d "$WT" ] || stop 1 worktree-missing "$WT"
[ -d "$WT/node_modules" ] ||
  stop 1 node-modules-missing "run pnpm install --frozen-lockfile in $WT outside the sandbox"

# Launch in the background, detached from this shell's session so that the run survives the
# caller; caffeinate keeps the Mac awake for up to 30 minutes of Codex work (规划/11 §2.2).
RUN="$(cd "$RUN" && pwd -P)"
launcher=(perl -e 'use POSIX qw(setsid); setsid(); exec { $ARGV[0] } @ARGV; exit 127')
if command -v caffeinate >/dev/null 2>&1; then
  launcher+=(caffeinate -i)
fi
"${launcher[@]}" "$TRUSTED/tools/agent/codex-run.sh" impl "$TASK" --phase "$PHASE" \
  >"$RUN/dispatch.log" 2>&1 </dev/null &
pid=$!

state_args=(--state doing --pid "$pid" --started-at "$(agent_now_utc)")
# CR-09: after a handover Codex is the implementer; codex-run.sh then refuses a Codex code review.
if [ "$PHASE" = handover ]; then state_args+=(--implementer codex); fi
node "$OPS/state.ts" set "$TASK" "${state_args[@]}" >/dev/null 2>"$ERR_FILE" ||
  log "warning: run started (pid $pid) but state.ts set failed: $(last_error)"

emit --str action=dispatched --num "pid=$pid" --str "run=$RUN" --str "phase=$PHASE"
