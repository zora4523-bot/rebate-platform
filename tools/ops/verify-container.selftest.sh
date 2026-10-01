#!/usr/bin/env bash
# End-to-end self-test of verify-container.sh against a small fixture pnpm workspace.
# Needs Docker and network access (image build, one `pnpm fetch`), so it is NOT part
# of `pnpm verify`; the orchestrator runs it by hand after changing the verify recipe:
#
#   bash tools/ops/verify-container.selftest.sh [--keep-store]
#
# Everything it creates is named couli-selftest-* (override with COULI_VERIFY_PREFIX)
# and removed at the end; fixtures and run output live under <repo>/.tmp/verify-selftest/.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$SELF_DIR/../.." && pwd -P)"
BASE="$REPO/.tmp/verify-selftest"
KEEP_STORE=0
[ "${1:-}" != '--keep-store' ] || KEEP_STORE=1

export COULI_RUNS="$BASE/runs"
export COULI_TRUSTED_ROOT="$REPO"
export COULI_VERIFY_PREFIX="${COULI_VERIFY_PREFIX:-couli-selftest}"
export PROP_SEED=424242
PREFIX="$COULI_VERIFY_PREFIX"
# The store volumes of this prefix are deleted at the end: never the real ones.
if [ "$PREFIX" = 'couli-verify' ]; then
  echo "COULI_VERIFY_PREFIX must differ from the production prefix couli-verify" >&2
  exit 2
fi

PNPM_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' "$REPO/package.json" | head -n 1)"
[ -n "$PNPM_VERSION" ] || { echo "cannot read packageManager from $REPO/package.json" >&2; exit 2; }

failures=0
note() { printf '%s\n' "$*"; }
fail() {
  note "FAIL: $*"
  failures=$((failures + 1))
}

rm -rf "$BASE"
mkdir -p "$BASE/base/scripts"

# --- fixture ------------------------------------------------------------------
cat >"$BASE/base/package.json" <<EOF
{
  "name": "verify-selftest",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@$PNPM_VERSION",
  "scripts": { "verify": "__VERIFY__" },
  "dependencies": { "pg": "8.23.0" }
}
EOF
cat >"$BASE/base/pnpm-workspace.yaml" <<'EOF'
packages: []
minimumReleaseAge: 10080
managePackageManagerVersions: false
EOF
cat >"$BASE/base/scripts/sandbox.mjs" <<'EOF'
// Passes only when the container is locked down as the recipe says.
import { existsSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const problems = [];
if (typeof pg.Client !== 'function') problems.push('pg was not installed from the offline store');
if (process.getuid() === 0) problems.push('running as root');
if (!process.cwd().startsWith('/work/')) problems.push(`cwd is ${process.cwd()}, not below /work`);
for (const file of ['/src/probe', '/etc/probe', '/usr/local/probe', '/store/probe']) {
  try {
    writeFileSync(file, 'x');
    problems.push(`${file} is writable`);
  } catch {
    // expected: read-only
  }
}
for (const dir of ['.git', '.tmp', 'dist', '.turbo']) {
  if (existsSync(dir)) problems.push(`${dir} was copied into the container`);
}
if (existsSync('node_modules/host-marker')) problems.push('host node_modules was copied');
if (existsSync('/var/run/docker.sock')) problems.push('the Docker socket is visible');
if (process.env.PROP_SEED !== '424242') problems.push(`PROP_SEED is ${process.env.PROP_SEED}`);
if (!process.env.TEST_PG_ADMIN_URL) problems.push('TEST_PG_ADMIN_URL is not set');
console.log(problems.length === 0 ? 'sandbox ok' : problems.join('\n'));
process.exit(problems.length === 0 ? 0 : 1);
EOF
cat >"$BASE/base/scripts/net.mjs" <<'EOF'
// Exit 42 when nothing outside the internal network is reachable (expected), 0 otherwise.
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 3000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    for (const event of ['error', 'timeout']) {
      socket.once(event, () => {
        socket.destroy();
        resolve(false);
      });
    }
  });
}

const reached = [];
try {
  await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(5000) });
  reached.push('https://registry.npmjs.org');
} catch {
  // expected
}
for (const name of ['registry.npmjs.org', 'host.docker.internal']) {
  try {
    await lookup(name);
    reached.push(`dns:${name}`);
  } catch {
    // expected
  }
}
if (await tcp('1.1.1.1', 443)) reached.push('tcp:1.1.1.1:443');
if (await tcp('192.168.65.254', 80)) reached.push('tcp:docker-desktop-host');
console.log(reached.length === 0 ? 'no way out' : `reachable: ${reached.join(', ')}`);
process.exit(reached.length === 0 ? 42 : 0);
EOF
cat >"$BASE/base/scripts/pg.mjs" <<'EOF'
// Needs the one-shot PostgreSQL passed in as TEST_PG_ADMIN_URL.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.TEST_PG_ADMIN_URL;
if (!url) {
  console.log('TEST_PG_ADMIN_URL is not set');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
const version = (await client.query('show server_version')).rows[0].server_version;
await client.query('create extension if not exists vector');
const vector = (await client.query("select extversion from pg_extension where extname = 'vector'"))
  .rows[0].extversion;
await client.end();
const one = execFileSync('psql', [url, '-Atc', 'select 1'], { encoding: 'utf8' }).trim();
const dump = execFileSync('pg_dump', ['--schema-only', '--no-owner', url], { encoding: 'utf8' });
console.log(`server ${version}, pgvector ${vector}, psql ${one}, pg_dump ${dump.length} bytes`);
process.exit(version.startsWith('18.') && one === '1' && dump.includes('vector') ? 0 : 1);
EOF

note "resolving the fixture lockfile (host, networked)"
(cd "$BASE/base" && pnpm install --lockfile-only --silent)
[ -f "$BASE/base/pnpm-lock.yaml" ] || { echo "no lockfile was produced" >&2; exit 2; }

make_case() { # <name> <verify command>
  local dir="$BASE/$1"
  mkdir -p "$dir"
  cp -R "$BASE/base/." "$dir/"
  # `|` cannot appear in the commands used below.
  sed -i.bak "s|__VERIFY__|$2|" "$dir/package.json"
  rm -f "$dir/package.json.bak"
  # Things the container must not see.
  mkdir -p "$dir/.tmp" "$dir/dist" "$dir/.turbo" "$dir/node_modules/host-marker"
}
make_case pass 'node scripts/sandbox.mjs'
make_case fail "node -e 'process.exit(7)'"
make_case net 'node scripts/net.mjs'
make_case pg 'node scripts/pg.mjs'
make_case slow "node -e 'setTimeout(()=>{},600000)'"

# --- runs ---------------------------------------------------------------------
field() { # <result.json> <key>
  sed -n "s/^  \"$2\": \"\\{0,1\\}\\([^\",]*\\)\"\\{0,1\\},\\{0,1\\}\$/\\1/p" "$1"
}

run_case() { # <label> <id> <case dir> <expected exit> <expected mode> [extra args...]
  local label="$1" id="$2" dir="$3" want="$4" mode="$5"
  shift 5
  local started rc=0 secs result
  started=$(date +%s)
  bash "$SELF_DIR/verify-container.sh" "$id" --worktree "$BASE/$dir" "$@" >/dev/null 2>"$BASE/$id.stderr" || rc=$?
  secs=$(($(date +%s) - started))
  result="$COULI_RUNS/$id/verify/1/result.json"
  if [ "$rc" -ne "$want" ]; then
    fail "$label: exit $rc, expected $want (see $COULI_RUNS/$id/verify/1/log.txt)"
  elif [ ! -f "$result" ]; then
    fail "$label: no result.json"
  elif [ "$(field "$result" exit_code)" != "$want" ] || [ "$(field "$result" mode)" != "$mode" ] ||
    [ "$(field "$result" prop_seed)" != '424242' ]; then
    fail "$label: unexpected result.json: $(tr -d '\n' <"$result")"
  else
    note "ok: $label (exit $rc, ${secs}s)"
  fi
}

note "first run includes the image build (if not cached) and the store fetch"
run_case 'pass: locked-down container, offline install' ST-01 pass 0 container
run_case 'fail: exit code is propagated' ST-02 fail 7 container
run_case 'net: no way out of the internal network' ST-03 net 42 container
run_case 'pg: one-shot PostgreSQL 18 + pgvector, psql, pg_dump' ST-04 pg 0 container
COULI_VERIFY_TIMEOUT_SECS=5 run_case 'slow: time limit gives 124' ST-05 slow 124 container
run_case 'host fallback is recorded as mode host' ST-06 fail 7 host --host

rc=0
mkdir -p "${TMPDIR:-/tmp}/couli-selftest-wt.$$"
cp "$BASE/pass/package.json" "${TMPDIR:-/tmp}/couli-selftest-wt.$$/"
bash "$SELF_DIR/verify-container.sh" ST-07 --worktree "${TMPDIR:-/tmp}/couli-selftest-wt.$$" >/dev/null 2>&1 || rc=$?
rm -rf "${TMPDIR:-/tmp}/couli-selftest-wt.$$"
if [ "$rc" -eq 2 ]; then note 'ok: a worktree under $TMPDIR is refused'; else fail "tmp worktree: exit $rc, expected 2"; fi

note 'steps and timestamps:'
for id in ST-01 ST-02 ST-03 ST-04 ST-05; do
  if [ -f "$COULI_RUNS/$id/verify/1/log.txt" ]; then
    grep '^\[verify-container ' "$COULI_RUNS/$id/verify/1/log.txt" | sed "s|^|  $id |" || true
  fi
done

# --- leftovers ----------------------------------------------------------------
left="$(docker ps -a --format '{{.Names}}' | grep -c "^$PREFIX-" || true)"
[ "$left" -eq 0 ] || fail "$left container(s) named $PREFIX-* were left behind"
left="$(docker network ls --format '{{.Name}}' | grep -c "^$PREFIX-" || true)"
[ "$left" -eq 0 ] || fail "$left network(s) named $PREFIX-* were left behind"
if [ "$KEEP_STORE" -eq 0 ]; then
  docker volume ls --format '{{.Name}}' | grep "^$PREFIX-store-" | while IFS= read -r vol; do
    docker volume rm "$vol" >/dev/null
  done
fi

if [ "$failures" -eq 0 ]; then
  note 'verify-container self-test passed'
else
  note "verify-container self-test: $failures failure(s)"
  exit 1
fi
