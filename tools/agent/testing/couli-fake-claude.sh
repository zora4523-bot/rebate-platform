#!/usr/bin/env bash
# Fake `claude` binary for the claude-run.sh tests (selected through COULI_CLAUDE_BIN,
# ops/approvals.yaml id 36). It never talks to a model and uses no quota. FAKE_CLAUDE_SCENARIO
# picks the behaviour, FAKE_CODEX_LOG is a directory that receives what the fake observed (argv,
# stdin, working directory, account environment).
set -euo pipefail

LOG="${FAKE_CODEX_LOG:-}"
SCENARIO="${FAKE_CLAUDE_SCENARIO:-ok}"

if [ "${1:-}" = '--version' ]; then
  echo '0.0.0 (Claude Code fake)'
  exit 0
fi

if [ "${1:-}" = '--help' ]; then
  if [ "$SCENARIO" = 'help-missing-flag' ]; then
    echo '  -p, --print'
    exit 0
  fi
  cat <<'EOF'
Usage: claude [options] [command] [prompt] (fake)
  --add-dir <directories...>
  --allowedTools, --allowed-tools <tools...>
  --disable-slash-commands
  --effort <level>
  --include-partial-messages
  --json-schema <schema>
  --model <model>
  --no-session-persistence
  --output-format <format>   "text", "json", or "stream-json"
  -p, --print
  --permission-mode <mode>   "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"
  --restricted
  --safe-mode
  --strict-mcp-config
  --tools <tools...>
  --verbose
EOF
  exit 0
fi

[ "${1:-}" = '-p' ] || {
  echo "fake claude: unsupported invocation: $*" >&2
  exit 64
}

schema=''
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    --json-schema) schema="${args[$((i + 1))]:-}" ;;
  esac
  i=$((i + 1))
done

if [ -n "$LOG" ]; then
  mkdir -p "$LOG"
  printf '%s\0' "$@" >"$LOG/argv.nul"
  {
    printf 'wrapper=%s\n' "${COULI_CODEX_WRAPPER:-}"
    printf 'stdin=%s\n' "$(perl -e 'my @a = stat(STDIN); my @b = stat("/dev/null");
      print((@a && @b && $a[0] == $b[0] && $a[1] == $b[1]) ? "devnull" : "other")')"
    printf 'cwd=%s\n' "$(pwd -P)"
    printf 'config_dir=%s\n' "${CLAUDE_CONFIG_DIR:-}"
    printf 'api_key=%s\n' "${ANTHROPIC_API_KEY:+set}"
    printf 'pid=%s\n' "$$"
  } >"$LOG/observed.txt"
fi

emit() { printf '%s\n' "$1"; }
SESSION='"session_id":"5e55f4ke-0000-4000-8000-000000000001"'

# The structured output for the schema in --json-schema (review or impl).
answer() {
  if [ -n "${FAKE_CLAUDE_OUTPUT_FILE:-}" ]; then
    tr -d '\n' <"$FAKE_CLAUDE_OUTPUT_FILE"
    return
  fi
  case "$schema" in
    *'"verdict"'*) printf '%s' '{"verdict":"pass","summary":"fake review: nothing found","findings":[],"out_of_scope":[],"checklist":[]}' ;;
    *'"task_done"'*) printf '%s' '{"task_done":true,"files_changed":["src/a.ts"],"commands":[],"tests_passed":true,"deps_needed":[],"outside_needed":[],"blocked_reason":"","notes":"fake"}' ;;
    *)
      echo 'fake claude: unknown --json-schema' >&2
      exit 64
      ;;
  esac
}

start_events() {
  emit "{\"type\":\"system\",\"subtype\":\"init\",$SESSION,\"model\":\"claude-opus-5-5\"}"
  emit "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\"},$SESSION}"
}

finish_events() {
  local output
  output="$(answer)"
  emit "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"StructuredOutput\",\"input\":$output}]},$SESSION}"
  emit "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"api_error_status\":null,\"result\":\"done\",\"structured_output\":$output,$SESSION}"
  emit "{\"type\":\"system\",\"subtype\":\"task_summary\",\"detail\":null,$SESSION}"
}

case "$SCENARIO" in
  ok)
    start_events
    finish_events
    ;;
  usage-limit)
    start_events
    emit "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"rateLimitType\":\"five_hour\"},$SESSION}"
    emit "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"api_error_status\":429,\"result\":\"You've hit your limit · resets 3pm\",$SESSION}"
    exit 1
    ;;
  quoting-limit)
    # The usage-limit text appears only inside an ordinary message (quoted file content).
    start_events
    emit "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"You've hit your limit\"}]},$SESSION}"
    emit "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":\"boom\",$SESSION}"
    exit 1
    ;;
  no-result)
    start_events
    ;;
  no-structured-output)
    start_events
    emit "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"plain text\",$SESSION}"
    ;;
  write-untracked)
    # A review that leaves a file in the working tree (Claude has no read-only sandbox).
    start_events
    echo 'rogue' >rogue-review.txt
    finish_events
    ;;
  rewrite-modified)
    # A second edit of a file that was already modified: `git status` looks the same.
    start_events
    echo 'export const a = 3;' >src/a.ts
    finish_events
    ;;
  *)
    echo "fake claude: unknown scenario: $SCENARIO" >&2
    exit 64
    ;;
esac
exit 0
