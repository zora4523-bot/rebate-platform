#!/usr/bin/env bash
# dispatch.sh <id> — preflight and background launch of one implementation run
# (规划/11 §2.2 后台运行, §2.3 step 5, §2.5).
#
# Preflight, in this order; the first failure stops everything:
#   1. usage gate          node <TRUSTED>/tools/ops/usage.ts gate --task <id>   (exit 3 = blocked)
#                          `--mode impl --risk <RVn>` is added when tools/ops/task.ts can compute
#                          the risk level, so that the 70%-97% quota tier is enforced (§1.3)
#   2. claim               node <TRUSTED>/tools/ops/state.ts claim <id> --owner <session>
#                          The owner is COULI_SESSION when set, else a name unique to this
#                          dispatch process; `--renew` is tried only when the claim on file is
#                          already held by this very owner (never for another session's claim)
#   3. count the attempt   node <TRUSTED>/tools/ops/state.ts bump-attempt <id> impl
#                          BEFORE launching, every time. A call that ends without output
#                          (timeout, capacity error, no `-o`, …) is given back by codex-run.sh
#                          (state.ts settle) when it finishes (§2.5)
#   4. task brief          RUN/brief.md, else node <TRUSTED>/tools/ops/brief.ts <id>. From the
#                          second attempt on the brief is always regenerated: every round is a
#                          new one and carries the previous failure output (§2.3 重试不用 resume)
#   5. worktree            <runs>/worktrees/<id> exists and has node_modules. Dependencies are
#                          installed by the orchestrator outside the sandbox; nothing is
#                          installed here.
# Then codex-run.sh impl <id> is started in the background in its own session (under
# `caffeinate -i` when available), pid and start time are recorded with state.ts set, and one
# JSON line is printed: {"action":"dispatched","pid":<n>,"run":"<RUN>"}.
#
# Exit codes: 0 dispatched | 3 usage gate closed | 1 a preflight check failed |
#             2 usage or internal error. On every non-zero exit one JSON line with
#             "action":"stopped" (gate) or "action":"none" says why.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF_REPO="$(cd "$SELF_DIR/../.." && pwd -P)"
# shellcheck source=tools/agent/common.sh
. "$SELF_DIR/common.sh"

log() { printf 'dispatch: %s\n' "$*" >&2; }
emit() { node "$SELF_DIR/meta.ts" emit "$@"; }

if [ $# -ne 1 ]; then
  log "usage: dispatch.sh <id>"
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
for script in usage.ts state.ts brief.ts; do
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

# 1. Usage gate (规划/11 §1.3, §2.5 全局熔断). The risk level is computed from the task paths by
# the trusted tools (never typed in); without it the gate still applies every global limit.
gate_args=(gate --task "$TASK")
if [ -f "$OPS/task.ts" ]; then
  risk="$(node "$OPS/task.ts" show "$TASK" --json 2>/dev/null |
    node "$SELF_DIR/meta.ts" get --file /dev/stdin risk 2>/dev/null || true)"
  case "$risk" in
    RV0 | RV1 | RV2) gate_args+=(--mode impl --risk "$risk") ;;
  esac
fi
gate_rc=0
gate_out="$(node "$OPS/usage.ts" "${gate_args[@]}" 2>"$ERR_FILE")" || gate_rc=$?
if [ "$gate_rc" != 0 ]; then
  emit --str action=stopped --str "task=$TASK" --str reason=usage-gate \
    --num "gate_exit=$gate_rc" --json "gate=${gate_out:-null}"
  if [ "$gate_rc" = 3 ]; then exit 3; fi
  log "usage gate failed with exit $gate_rc: $(last_error)"
  exit 2
fi

# 2. Claim (规划/11 §2.2 领任务). Every orchestrator session has its own owner name, so a
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
running_pid="$(node "$OPS/state.ts" get "$TASK" 2>/dev/null |
  node "$SELF_DIR/meta.ts" get --file /dev/stdin pid 2>/dev/null || true)"
case "$running_pid" in
  '' | null | *[!0-9]*) ;;
  *)
    if kill -0 "$running_pid" 2>/dev/null; then
      stop 1 run-in-progress "pid $running_pid of a previous dispatch is still alive (run tools/agent/post-run.sh $TASK first)"
    fi
    ;;
esac

# 3. Count the attempt before anything is launched (规划/11 §2.5). A previous call that ended
# without output (capacity error included) was already given back by codex-run.sh.
bump_rc=0
node "$OPS/state.ts" bump-attempt "$TASK" impl >/dev/null 2>"$ERR_FILE" || bump_rc=$?
if [ "$bump_rc" = 1 ]; then stop 1 attempts-exhausted "$(last_error)"; fi
if [ "$bump_rc" != 0 ]; then stop 2 state-error "$(last_error)"; fi

# 4. Task brief. A first attempt uses the brief that is already there. Every later attempt gets
# a fresh one: brief.ts reads the attempt number and the previous failure output from the
# in-flight state, which the orchestrator updates between rounds (state.ts set --last-error).
attempts_now="$(node "$OPS/state.ts" get "$TASK" 2>/dev/null |
  node "$SELF_DIR/meta.ts" get --file /dev/stdin attempts.impl 2>/dev/null || true)"
case "$attempts_now" in
  '' | *[!0-9]*) attempts_now=1 ;;
esac
if [ ! -s "$RUN/brief.md" ] || [ "$attempts_now" -ge 2 ]; then
  mkdir -p "$RUN"
  node "$OPS/brief.ts" "$TASK" --out "$RUN/brief.md" >/dev/null 2>"$ERR_FILE" ||
    stop 1 brief-failed "$(last_error)"
  [ -s "$RUN/brief.md" ] || stop 1 brief-failed "brief.ts wrote no $RUN/brief.md"
fi

# 5. Worktree with dependencies already installed (never install here).
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
"${launcher[@]}" "$TRUSTED/tools/agent/codex-run.sh" impl "$TASK" \
  >"$RUN/dispatch.log" 2>&1 </dev/null &
pid=$!

node "$OPS/state.ts" set "$TASK" --state doing --pid "$pid" --started-at "$(agent_now_utc)" \
  >/dev/null 2>"$ERR_FILE" ||
  log "warning: run started (pid $pid) but state.ts set failed: $(last_error)"

emit --str action=dispatched --num "pid=$pid" --str "run=$RUN"
