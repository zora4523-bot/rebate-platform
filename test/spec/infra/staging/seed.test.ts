import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { asset } from './kit.ts';

// B1-01zzn ledger (D10-299 B) defines these local AC identifiers. Container-only command
// fixtures: relocate node paths and stub Docker/flock, preserving deploy.sh's control flow.
// The fake `docker run` really executes the in-container command after the image, with a fake
// `node` that records which packages/db script it was given, so any shell form chaining migrate
// and seed inside the one migration container is accepted. No daemon, network, database or real
// node credential is used.
const CREDENTIAL = 'synthetic_seed_step_password';
const CURRENT = '# current compose next to deploy.sh\n';
const SAVED = '# compose saved with the previous tag\n';
const NODE_FILES = [
  '/etc/couli/staging.env',
  '/etc/couli/staging-payout.env',
  '/etc/couli/staging-migrator.env',
  '/etc/pki/ca.crt',
  '/etc/couli-keys/master.key',
  '/etc/couli-keys/keyring.json',
  '/etc/couli-jwt/es256.pem',
  '/etc/couli-jwt/key-id',
] as const;
const MIGRATOR_ENV = './node-2.fixture';
const DATABASE_CA = './node-3.fixture';
const SETTLED = Array<string>(5).fill('settle');
const DOCKER = `#!/bin/bash
set -eu
case "$1 $2" in
  'image inspect') exit 0 ;;
  'image ls') printf '%s\\n' "$COULI_API_TAG"; exit 0 ;;
  'image rm') exit 0 ;;
esac
case "$1" in
  run)
    shift
    printf 'run\\n' >> "$FAKE_TRACE"
    for arg in "$@"; do printf '%s\\0' "$arg" >> "$FAKE_RUN_ARGS"; done
    entrypoint=''
    while [ "$#" -gt 0 ] && [ "$1" != "couli-api:$COULI_API_TAG" ]; do
      case "$1" in
        --entrypoint) entrypoint="$2"; shift 2 ;;
        --entrypoint=*) entrypoint="\${1#--entrypoint=}"; shift ;;
        *) shift ;;
      esac
    done
    if [ "$#" -eq 0 ]; then printf 'unsupported fake docker run\\n' >&2; exit 93; fi
    shift
    if [ -n "$entrypoint" ]; then exec "$entrypoint" "$@"; fi
    if [ "$#" -eq 0 ]; then printf 'unsupported fake docker run\\n' >&2; exit 93; fi
    exec "$@" ;;
  inspect) printf '0\\n0\\n0\\n0\\n0\\n'; exit 0 ;;
  compose)
    shift
    compose=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -f|--file) compose="$2"; shift 2 ;;
        --env-file) shift 2 ;;
        up)
          test -f "$compose"
          printf 'up|%s\\n' "$COULI_API_TAG" >> "$FAKE_TRACE"
          if [ "$COULI_API_TAG" = "$FAKE_UP_FAIL" ]; then exit 1; fi
          exit 0 ;;
        ps) printf 'fixture-container\\n'; exit 0 ;;
        exec) printf 'settle\\n' >> "$FAKE_TRACE"; exit 0 ;;
        *) printf 'unsupported fake compose command\\n' >&2; exit 93 ;;
      esac
    done ;;
esac
printf 'unsupported fake docker command\\n' >&2
exit 93
`;
// Stands in for node inside the image: only the two packages/db scripts are expected.
const NODE = `#!/bin/bash
set -eu
script=''
for arg in "$@"; do
  case "$arg" in
    *packages/db/scripts/migrate.ts|*packages/db/scripts/migrate.js) script=migrate ;;
    *packages/db/scripts/seed.ts|*packages/db/scripts/seed.js) script=seed ;;
  esac
done
if [ -z "$script" ]; then printf 'unsupported fake node command\\n' >&2; exit 93; fi
printf 'node:%s\\n' "$script" >> "$FAKE_TRACE"
if [ "$script" = "$FAKE_FAIL" ]; then printf 'fake %s failed\\n' "$script" >&2; exit 1; fi
exit 0
`;

interface State {
  previous?: string;
  switched?: string;
  saved?: string;
}

interface Options {
  fail?: 'migrate' | 'seed';
  upFail?: string;
}

interface Result {
  status: number | null;
  output: string;
  calls: string[];
  runArgs: string[];
}

function fixture(state: State, run: (directory: string) => void): void {
  const parent = resolve('.tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'seed-step-'));
  try {
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'state'));
    let script = asset('infra/staging/deploy.sh')
      .replaceAll('/var/lib/couli', './state')
      .replaceAll('/run/lock', './locks');
    for (const [index, path] of NODE_FILES.entries()) {
      const name = `node-${String(index)}.fixture`;
      script = script.replaceAll(path, `./${name}`);
      // Plain synthetic text, not an actual env file, key or certificate.
      writeFileSync(join(directory, name), `password=${CREDENTIAL}\n`);
    }
    writeFileSync(join(directory, 'deploy.sh'), script);
    writeFileSync(join(directory, 'compose.yaml'), CURRENT);
    writeFileSync(join(directory, 'bin/docker'), DOCKER, { mode: 0o755 });
    writeFileSync(join(directory, 'bin/node'), NODE, { mode: 0o755 });
    writeFileSync(join(directory, 'bin/flock'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    if (state.previous !== undefined) {
      writeFileSync(join(directory, 'state/staging-api.tag'), `${state.previous}\n`);
    }
    if (state.switched !== undefined) {
      writeFileSync(join(directory, 'state/staging-api.switched'), `${state.switched}\n`);
    }
    if (state.saved !== undefined) {
      writeFileSync(join(directory, `state/compose.${state.saved}.yaml`), SAVED);
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function deploy(directory: string, tag: string, options: Options = {}): Result {
  const trace = join(directory, 'calls');
  const runArgs = join(directory, 'run-args');
  writeFileSync(trace, '');
  writeFileSync(runArgs, '');
  const result = spawnSync('/bin/bash', [join(directory, 'deploy.sh'), tag], {
    cwd: directory,
    // Never inherit developer credentials or shell startup hooks.
    env: {
      PATH: `${join(directory, 'bin')}:/usr/bin:/bin`,
      LC_ALL: 'C',
      FAKE_TRACE: trace,
      FAKE_RUN_ARGS: runArgs,
      FAKE_FAIL: options.fail ?? '',
      FAKE_UP_FAIL: options.upFail ?? '',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error, 'fixture must finish without a spawn error or timeout').toBeUndefined();
  expect(result.signal).toBeNull();
  const output = result.stdout + result.stderr;
  expect(output, 'neither stdout nor stderr may expose a password').not.toContain(CREDENTIAL);
  expect(output).not.toMatch(/unsupported fake|command not found|syntax error/);
  return {
    status: result.status,
    output,
    calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
    runArgs: readFileSync(runArgs, 'utf8').split('\0').filter(Boolean),
  };
}

function stateFile(directory: string, name: string): string {
  const path = join(directory, 'state', name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

function envFiles(args: string[]): string[] {
  return args.flatMap((arg, index) => {
    if (arg === '--env-file') return [args[index + 1] ?? ''];
    return arg.startsWith('--env-file=') ? [arg.slice('--env-file='.length)] : [];
  });
}

it('[AC-B1-01zzn#1] 迁移成功后在同一次一次性迁移容器里接着跑种子，之后才切换五个进程', () => {
  const cases: { state: State; tag: string }[] = [
    // Fresh node: no successful tag yet.
    { state: {}, tag: 'T' },
    // A node with a successful, running tag deploying a new one.
    { state: { previous: 'A', switched: 'A', saved: 'A' }, tag: 'B' },
  ];
  for (const { state, tag } of cases) {
    fixture(state, (directory) => {
      const result = deploy(directory, tag);
      expect(result.status).toBe(0);
      expect(result.calls, 'one docker run: migrate, then seed, then the switch').toEqual([
        'run',
        'node:migrate',
        'node:seed',
        `up|${tag}`,
        ...SETTLED,
      ]);
      // Seed shares the migration container: migrator credentials and database CA only.
      expect(result.runArgs).toContain(`couli-api:${tag}`);
      expect(result.runArgs).toContain('--rm');
      expect(envFiles(result.runArgs)).toEqual([MIGRATOR_ENV]);
      expect(result.runArgs.some((arg) => arg.includes(DATABASE_CA))).toBe(true);
      for (const [index, path] of NODE_FILES.entries()) {
        const name = `./node-${String(index)}.fixture`;
        if (name === MIGRATOR_ENV || name === DATABASE_CA) continue;
        expect(result.runArgs.join('\n'), `${path} not given to the seed`).not.toContain(name);
      }
      expect(stateFile(directory, 'staging-api.tag')).toBe(tag);
      expect(stateFile(directory, 'staging-api.switched')).toBe(tag);
    });
  }
}, 120_000);

it('[AC-B1-01zzn#2] 种子失败按迁移失败处理：非零退出，不切换、不标记、不记录标签', () => {
  const cases: { state: State; tag: string }[] = [
    { state: {}, tag: 'T' },
    { state: { previous: 'A', switched: 'A', saved: 'A' }, tag: 'B' },
    // Redeploying the running tag stops the same way.
    { state: { previous: 'A', switched: 'A', saved: 'A' }, tag: 'A' },
  ];
  for (const fail of ['seed', 'migrate'] as const) {
    for (const { state, tag } of cases) {
      fixture(state, (directory) => {
        const result = deploy(directory, tag, { fail });
        expect(result.status, `${fail} failure must fail the deployment`).not.toBe(0);
        expect(result.calls, `${fail} failure stops before any switch or settle`).toEqual(
          fail === 'seed' ? ['run', 'node:migrate', 'node:seed'] : ['run', 'node:migrate'],
        );
        // Running processes untouched: no uncertain mark, no tag, no compose copy recorded.
        expect(stateFile(directory, 'staging-api.tag')).toBe(state.previous ?? '');
        expect(stateFile(directory, 'staging-api.switched')).toBe(state.switched ?? '');
        if (tag !== state.saved) {
          expect(existsSync(join(directory, `state/compose.${tag}.yaml`))).toBe(false);
        }
        if (state.saved !== undefined) {
          expect(readFileSync(join(directory, `state/compose.${state.saved}.yaml`), 'utf8')).toBe(
            SAVED,
          );
        }
      });
    }
  }
}, 240_000);

it('[AC-B1-01zzn#3] 每次部署都跑一次种子（种子可重复执行）：重部署同一标签不跳过，自动回退不再跑', () => {
  fixture({}, (directory) => {
    for (const tag of ['T', 'T', 'U']) {
      const result = deploy(directory, tag);
      expect(result.status).toBe(0);
      expect(result.calls, `deploy.sh ${tag} seeds again`).toEqual([
        'run',
        'node:migrate',
        'node:seed',
        `up|${tag}`,
        ...SETTLED,
      ]);
    }
    expect(stateFile(directory, 'staging-api.tag')).toBe('U');
  });
  // Health failure: seeded once before the switch; the rollback adds no docker run.
  fixture({ previous: 'A', switched: 'A', saved: 'A' }, (directory) => {
    const result = deploy(directory, 'B', { upFail: 'B' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['run', 'node:migrate', 'node:seed', 'up|B', 'up|A', ...SETTLED]);
    expect(stateFile(directory, 'staging-api.tag')).toBe('A');
    expect(stateFile(directory, 'staging-api.switched')).toBe('A');
  });
}, 180_000);
