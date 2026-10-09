// The docker commands verify-container.sh issues for the one-shot services (PostgreSQL, Redis):
// a stub `docker` first on PATH records every call and answers like a healthy daemon, so the
// plan — what starts on which network with which settings, what the verify container receives,
// what is removed at the end — is checked without Docker. Whether the real images behave is the
// job of tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  OPS_DIR,
  removeDir,
  scratchDir,
  writeFiles,
} from './test-helpers.ts';

const SCRIPT = join(OPS_DIR, 'verify-container.sh');
const PREFIX = 'couli-stubtest';
const PG_IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie';
const REDIS_IMAGE = 'redis:7.4.11-alpine';
const REDIS_URL = 'redis://redis:6379/0';
/** The one-shot PostgreSQL URL a container gets; recognised by its value. */
const PG_URL = /^postgres:\/\/postgres:[0-9a-f]{32}@pg:5432\/postgres$/;
/** What the host may have set: it must never reach a verify container. */
const HOST_REDIS_URL = 'redis://host.invalid:1/9';
/** Settings of infra/local/compose.yaml (ADR-0001 §4.2 #17): no RDB, no AOF, noeviction. */
const REDIS_SETTINGS = {
  save: '',
  appendonly: 'no',
  maxmemory: '256mb',
  'maxmemory-policy': 'noeviction',
};

// Stand-in for the docker CLI. Every call is appended to STUB_DOCKER_LOG with the environment
// it hands to the container: `-e NAME` takes the caller's value of NAME, `-e NAME=value` its own.
// STUB_DOCKER_FAIL=redis-start fails `run -d` of the Redis container; redis-exits makes it a
// container that has stopped (`inspect` says not running, `exec` fails). STUB_DOCKER_LOADING=<n>
// answers the first n `redis-cli ping` with a LOADING reply (exit 0); STUB_DOCKER_RUN_EXIT is the
// exit code of the verify / red / browser container. STUB_DOCKER_FAIL=image-missing makes
// `image inspect` fail, so the script builds the image (the `build` call is recorded).
// STUB_DOCKER_SCREENSHOT=1 makes the browser container leave one PNG in <out>/screenshots (where
// Vitest browser mode writes), STUB_DOCKER_SMOKE_SHOTS=<n> n build smoke PNGs (smoke-<i>.png at the
// top of <out>/screenshots).
const STUB = String.raw`'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const logFile = process.env.STUB_DOCKER_LOG;
const earlier = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l).args)
  : [];
const env = {};
args.forEach((a, i) => {
  if (args[i - 1] !== '-e') return;
  const eq = a.indexOf('=');
  if (eq === -1) env[a] = process.env[a] ?? null;
  else env[a.slice(0, eq)] = a.slice(eq + 1);
});
fs.appendFileSync(logFile, JSON.stringify({ args, env }) + '\n');
const failures = (process.env.STUB_DOCKER_FAIL || '').split(',');
const aboutRedis = args.some((a) => a.includes('-redis-'));
function answer(text, code) {
  if (text !== '') process.stdout.write(text + '\n');
  process.exit(code);
}
if (args[0] === 'version') answer('28.0.1', 0);
if (args[0] === 'image' && args[1] === 'inspect' && failures.includes('image-missing')) {
  process.stderr.write('Error: No such image\n');
  process.exit(1);
}
if (args[0] === 'run' && args.includes('-d')) {
  if (failures.includes('redis-start') && aboutRedis) {
    process.stderr.write('stub: cannot start the container\n');
    process.exit(125);
  }
  answer('0123456789ab', 0);
}
if (args[0] === 'run' && args.includes('couli-verify-entrypoint')) {
  const out = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/out'));
  if (process.env.STUB_DOCKER_SCREENSHOT === '1' && args.at(-1) === 'browser' && out) {
    const dir = out.slice(0, -':/out'.length) + '/screenshots/spec/x.browser.test.ts';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/shot-chromium-linux.png', 'png');
  }
  const smokeShots = Number(process.env.STUB_DOCKER_SMOKE_SHOTS || '0');
  if (smokeShots > 0 && args.at(-1) === 'browser' && out) {
    const dir = out.slice(0, -':/out'.length) + '/screenshots';
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < smokeShots; i += 1) fs.writeFileSync(dir + '/smoke-' + i + '.png', 'png');
  }
  answer('', Number(process.env.STUB_DOCKER_RUN_EXIT || '0'));
}
if (args[0] === 'inspect') answer(failures.includes('redis-exits') && aboutRedis ? 'false' : 'true', 0);
if (args[0] === 'exec' && args.includes('redis-cli')) {
  if (failures.includes('redis-exits')) {
    process.stderr.write('Error response from daemon: container is not running\n');
    process.exit(1);
  }
  const pings = earlier.filter((a) => a[0] === 'exec' && a.includes('redis-cli')).length;
  const loading = Number(process.env.STUB_DOCKER_LOADING || '0');
  answer(pings < loading ? 'LOADING Redis is loading the dataset in memory' : 'PONG', 0);
}
answer('', 0);
`;

type Call = { args: string[]; env: Record<string, string | null> };
type Run = { status: number; stdout: string; stderr: string; calls: Call[] };

let base = '';
let runs = '';
let bin = '';
let logs = 0;

beforeAll(() => {
  base = scratchDir('verify-services');
  runs = join(base, 'runs');
  bin = join(base, 'bin');
  writeFiles(base, { 'bin/docker-stub.cjs': STUB });
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'docker-stub.cjs')}' "$@"\n`,
  );
  chmodSync(docker, 0o755);
});
afterAll(() => removeDir(base));

const PLAIN_LOCK = "lockfileVersion: '9.0'\n";

/**
 * A pnpm 10 lockfile that has playwright `version` (and playwright-core, which must not be
 * taken for it): an importer entry, the packages section and the snapshots section.
 */
function lockWithPlaywright(version: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  test:',
    '    devDependencies:',
    '      playwright:',
    `        specifier: ${version}`,
    `        version: ${version}`,
    '',
    'packages:',
    '',
    `  playwright-core@${version}:`,
    '    resolution: {integrity: sha512-core}',
    '',
    `  playwright@${version}:`,
    '    resolution: {integrity: sha512-playwright}',
    '',
    'snapshots:',
    '',
    `  playwright-core@${version}: {}`,
    '',
    `  playwright@${version}:`,
    '    dependencies:',
    `      playwright-core: ${version}`,
    '',
  ].join('\n');
}

/** A workspace the container path accepts (pinned pnpm, lockfile, workspace file). */
function workspace(name: string, lock = PLAIN_LOCK): string {
  const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const dir = join(base, name);
  writeFiles(dir, {
    'package.json': `${JSON.stringify(
      { name, private: true, packageManager: root.packageManager, scripts: { verify: 'true' } },
      null,
      2,
    )}\n`,
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': lock,
  });
  return dir;
}

/** Runs the script with the stub docker; the host has TEST_REDIS_URL set. */
function run(args: string[], env: Record<string, string> = {}): Run {
  logs += 1;
  const log = join(base, `calls-${String(logs)}.jsonl`);
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      COULI_RUNS: runs,
      COULI_TRUSTED_ROOT: repoRoot(),
      COULI_VERIFY_PREFIX: PREFIX,
      TEST_REDIS_URL: HOST_REDIS_URL,
      // What the script hands on to the container from the caller's environment (PROP_SEED,
      // PROP_RUNS, COULI_VERIFY_TIMEOUT_SECS as VERIFY_TIMEOUT_SECS) is cleared, so the caller's
      // settings (the orchestrator verifies with PROP_RUNS=100000) do not change what a test
      // sees; a test sets them explicitly when it needs them.
      PROP_RUNS: undefined,
      PROP_SEED: undefined,
      COULI_VERIFY_TIMEOUT_SECS: undefined,
      // The external services of the test machine are off unless a test turns them on.
      COULI_VERIFY_PG_SOCKET_DIR: undefined,
      COULI_VERIFY_PG_PORT: undefined,
      COULI_VERIFY_PG_ADMIN_USER: undefined,
      COULI_VERIFY_PG_ADMIN_PASSWORD_FILE: undefined,
      COULI_VERIFY_REDIS_SOCKET: undefined,
      STUB_DOCKER_LOG: log,
      ...env,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Call)
    : [];
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, calls };
}

/** The value that follows `flag` in `args`, or null. */
function valueOf(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/** `-e NAME` pairs of a `docker run`. */
function passedEnv(args: readonly string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === '-e' ? [arg.replace(/=.*$/s, '')] : []));
}

/** `--opt value` / `opt value` words as a settings record. */
function settings(words: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < words.length; i += 2) {
    out[(words[i] ?? '').replace(/^--/, '')] = words[i + 1] ?? '';
  }
  return out;
}

function containerRuns(calls: readonly Call[], image: string): Call[] {
  return calls.filter(
    (c) => c.args[0] === 'run' && c.args.includes('-d') && c.args.includes(image),
  );
}

function entrypointRun(calls: readonly Call[]): Call | undefined {
  return calls.find((c) => c.args.includes('couli-verify-entrypoint'));
}

/** The values handed to the container of `call` that are one-shot PostgreSQL URLs. */
function pgUrls(call: Call | undefined): string[] {
  return Object.values(call?.env ?? {}).filter((v): v is string => v !== null && PG_URL.test(v));
}

/** True when TEST_REDIS_URL does not reach the container of `call`, in any form. */
function noRedisUrl(call: Call | undefined): boolean {
  return (call?.args ?? []).every((a) => !a.includes('TEST_REDIS_URL'));
}

it(
  'pnpm verify: Redis starts beside PostgreSQL on the internal network and the run gets both URLs',
  () => {
    const res = run(['V2-01', '--worktree', workspace('verify')], {
      STUB_DOCKER_LOADING: '2',
      STUB_DOCKER_RUN_EXIT: '3',
      PROP_RUNS: '7',
    });
    // The exit code of the verify container is the result.
    expect(res.status, res.stderr).toBe(3);
    const result = JSON.parse(
      readFileSync(join(runs, 'V2-01', 'verify', '1', 'result.json'), 'utf8'),
    ) as { script: string; exit_code: number };
    expect(result).toMatchObject({ script: 'verify', exit_code: 3 });

    const { calls } = res;
    const network = calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create');
    const net = network?.args.at(-1) ?? '';
    expect(net).toMatch(/^couli-stubtest-net-v2-01-1-\d+$/);
    expect(network?.args).toContain('--internal');

    // Exactly one Redis: on that network only, alias `redis`, data on tmpfs, no published
    // port, the settings of the local stack.
    const redis = containerRuns(calls, REDIS_IMAGE);
    expect(redis).toHaveLength(1);
    const redisName = valueOf(redis[0]?.args ?? [], '--name') ?? '';
    expect(redisName).toMatch(/^couli-stubtest-redis-v2-01-1-\d+$/);
    expect(redis[0]?.args).toEqual([
      'run',
      '-d',
      '--name',
      redisName,
      '--label',
      'couli.verify=1',
      '--label',
      'couli.task=V2-01',
      '--network',
      net,
      '--network-alias',
      'redis',
      '--tmpfs',
      '/data',
      REDIS_IMAGE,
      'redis-server',
      ...Object.entries(REDIS_SETTINGS).flatMap(([key, value]) => [`--${key}`, value]),
    ]);

    // PostgreSQL is still there, on the same network, with a fresh random password.
    const pg = containerRuns(calls, PG_IMAGE);
    expect(pg).toHaveLength(1);
    expect(valueOf(pg[0]?.args ?? [], '--network')).toBe(net);
    expect(valueOf(pg[0]?.args ?? [], '--network-alias')).toBe('pg');
    const pgName = valueOf(pg[0]?.args ?? [], '--name') ?? '';
    expect(pgName).toMatch(/^couli-stubtest-pg-v2-01-1-\d+$/);
    const pgPassword = pg[0]?.env['POSTGRES_PASSWORD'] ?? '';
    expect(pgPassword).toMatch(/^[0-9a-f]{32}$/);

    // The run starts only after Redis answered PONG (two LOADING replies first; the container
    // was still running each time).
    const verifyAt = calls.findIndex((c) => c.args.includes('couli-verify-entrypoint'));
    const pings = calls.flatMap((c, i) =>
      c.args[0] === 'exec' && c.args.includes('redis-cli') ? [i] : [],
    );
    expect(pings).toHaveLength(3);
    expect(calls[pings[0] ?? -1]?.args).toEqual(['exec', redisName, 'redis-cli', 'ping']);
    expect(Math.max(...pings)).toBeLessThan(verifyAt);
    const inspections = calls.filter((c) => c.args[0] === 'inspect');
    expect(inspections.map((c) => c.args)).toEqual([
      ['inspect', '-f', '{{.State.Running}}', redisName],
      ['inspect', '-f', '{{.State.Running}}', redisName],
    ]);

    // The verify container: same network; TEST_REDIS_URL passed by name with the in-network
    // address, whatever the host had set; exactly one PostgreSQL URL (found by its value) with
    // the password the PostgreSQL container got.
    const verify = calls[verifyAt];
    expect(verify?.args.slice(-2)).toEqual(['couli-verify-entrypoint', 'verify']);
    expect(valueOf(verify?.args ?? [], '--network')).toBe(net);
    expect(passedEnv(verify?.args ?? [])).toContain('TEST_REDIS_URL');
    expect(verify?.args).not.toContain(`TEST_REDIS_URL=${REDIS_URL}`);
    expect(verify?.env['TEST_REDIS_URL']).toBe(REDIS_URL);
    expect(pgUrls(verify)).toEqual([`postgres://postgres:${pgPassword}@pg:5432/postgres`]);
    // PROP_RUNS, set explicitly for this run, is passed through unchanged.
    expect(verify?.env['PROP_RUNS']).toBe('7');

    // Cleanup removes both service containers (with their anonymous volumes), then the network.
    const rmAt = calls.findIndex((c) => c.args[0] === 'rm');
    expect(rmAt).toBeGreaterThan(verifyAt);
    expect(calls[rmAt]?.args.slice(0, 3)).toEqual(['rm', '-f', '-v']);
    expect(calls[rmAt]?.args).toEqual(expect.arrayContaining([pgName, redisName]));
    const netRmAt = calls.findIndex((c) => c.args[0] === 'network' && c.args[1] === 'rm');
    expect(netRmAt).toBeGreaterThan(rmAt);
    expect(calls[netRmAt]?.args).toEqual(['network', 'rm', net]);
  },
  CLI_TIMEOUT,
);

it(
  'a Redis that cannot start stops the run (exit 2, no result) and nothing is left behind',
  () => {
    const res = run(['V2-02', '--worktree', workspace('redis-fails')], {
      STUB_DOCKER_FAIL: 'redis-start',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('cannot start Redis');
    expect(existsSync(join(runs, 'V2-02', 'verify', '1', 'result.json'))).toBe(false);
    expect(entrypointRun(res.calls)).toBeUndefined();

    const pgName = valueOf(containerRuns(res.calls, PG_IMAGE)[0]?.args ?? [], '--name') ?? '';
    const redisName = valueOf(containerRuns(res.calls, REDIS_IMAGE)[0]?.args ?? [], '--name') ?? '';
    expect(redisName).toMatch(/^couli-stubtest-redis-v2-02-1-\d+$/);
    const rm = res.calls.find((c) => c.args[0] === 'rm');
    expect(rm?.args).toEqual(expect.arrayContaining([pgName, redisName]));
    const net = res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create');
    const netRm = res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'rm');
    expect(netRm?.args).toEqual(['network', 'rm', net?.args.at(-1)]);
  },
  CLI_TIMEOUT,
);

it(
  'a Redis that exits before it answers stops the run at once, with its logs, and nothing is left behind',
  () => {
    const res = run(['V2-04', '--worktree', workspace('redis-exits')], {
      STUB_DOCKER_FAIL: 'redis-exits',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Redis exited before it became ready');
    expect(existsSync(join(runs, 'V2-04', 'verify', '1', 'result.json'))).toBe(false);
    expect(entrypointRun(res.calls)).toBeUndefined();

    const redisName = valueOf(containerRuns(res.calls, REDIS_IMAGE)[0]?.args ?? [], '--name') ?? '';
    expect(redisName).toMatch(/^couli-stubtest-redis-v2-04-1-\d+$/);
    // One ping, one look at the container, its logs: no 60-second wait.
    const pings = res.calls.filter((c) => c.args[0] === 'exec' && c.args.includes('redis-cli'));
    expect(pings).toHaveLength(1);
    expect(res.calls.filter((c) => c.args[0] === 'inspect').map((c) => c.args)).toEqual([
      ['inspect', '-f', '{{.State.Running}}', redisName],
    ]);
    expect(res.calls.some((c) => c.args[0] === 'logs' && c.args[1] === redisName)).toBe(true);
    const pgName = valueOf(containerRuns(res.calls, PG_IMAGE)[0]?.args ?? [], '--name') ?? '';
    expect(res.calls.find((c) => c.args[0] === 'rm')?.args).toEqual(
      expect.arrayContaining([pgName, redisName]),
    );
    expect(res.calls.some((c) => c.args[0] === 'network' && c.args[1] === 'rm')).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  '--fast starts no service and passes no TEST_REDIS_URL, even when the host has one',
  () => {
    const res = run(['V2-03', '--worktree', workspace('fast'), '--fast']);
    expect(res.status, res.stderr).toBe(0);
    const { calls } = res;
    expect(calls.some((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const verify = entrypointRun(calls);
    expect(valueOf(verify?.args ?? [], '--network')).toBe('none');
    expect(noRedisUrl(verify)).toBe(true);
    // Nothing else is handed over either.
    expect(Object.keys(verify?.env ?? {}).sort()).toEqual([
      'PROP_SEED',
      'VERIFY_SCRIPT',
      'VERIFY_TIMEOUT_SECS',
    ]);
  },
  CLI_TIMEOUT,
);

/** A git fixture whose task (B1-02b, legacy ledger, see verify-container.test.ts) adds `files`. */
function redFixture(name: string, files: Record<string, string>, lock = PLAIN_LOCK): string {
  const repo = workspace(name, lock);
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  writeFiles(repo, files);
  return repo;
}

it(
  '--red: an integration group gets Redis and TEST_REDIS_URL like PostgreSQL',
  () => {
    const res = run([
      'B1-02b',
      '--worktree',
      redFixture('red-int', {
        'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
      }),
      '--red',
      '--base',
      'main',
    ]);
    // The stub writes no report, so the run stops after the red container (exit 2).
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for spec-int');
    const net =
      res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')?.args.at(-1) ?? '';
    expect(net).toMatch(/^couli-stubtest-net-b1-02b-1-\d+$/);
    const redis = containerRuns(res.calls, REDIS_IMAGE);
    expect(redis).toHaveLength(1);
    expect(valueOf(redis[0]?.args ?? [], '--network')).toBe(net);
    const red = entrypointRun(res.calls);
    expect(red?.args.at(-1)).toBe('red');
    expect(valueOf(red?.args ?? [], '--network')).toBe(net);
    expect(passedEnv(red?.args ?? [])).toContain('TEST_REDIS_URL');
    expect(red?.env['TEST_REDIS_URL']).toBe(REDIS_URL);
    const pgPassword = containerRuns(res.calls, PG_IMAGE)[0]?.env['POSTGRES_PASSWORD'] ?? '';
    expect(pgPassword).toMatch(/^[0-9a-f]{32}$/);
    expect(pgUrls(red)).toEqual([`postgres://postgres:${pgPassword}@pg:5432/postgres`]);
    const redisName = valueOf(redis[0]?.args ?? [], '--name') ?? '';
    expect(res.calls.find((c) => c.args[0] === 'rm')?.args).toContain(redisName);
    expect(res.calls.some((c) => c.args[0] === 'network' && c.args[1] === 'rm')).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  '--red: a unit-only plan gets no service, no network and no database URL',
  () => {
    const res = run([
      'B1-02b',
      '--worktree',
      redFixture('red-unit', {
        'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
      }),
      '--red',
      '--base',
      'main',
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for spec-unit');
    expect(res.calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const red = entrypointRun(res.calls);
    expect(red?.args.at(-1)).toBe('red');
    expect(valueOf(red?.args ?? [], '--network')).toBe('none');
    expect(noRedisUrl(red)).toBe(true);
    // Nothing else is handed over either.
    expect(Object.keys(red?.env ?? {}).sort()).toEqual([
      'PROP_SEED',
      'RED_PLAN',
      'VERIFY_TIMEOUT_SECS',
    ]);
  },
  CLI_TIMEOUT,
);

/** The image tag of the `docker build` call, or null when the script built nothing. */
function builtImage(calls: readonly Call[]): string | null {
  const build = calls.find((c) => c.args[0] === 'build');
  return build === undefined ? null : valueOf(build.args, '-t');
}

/** `--build-arg` values of the `docker build` call. */
function buildArgs(calls: readonly Call[]): string[] {
  const build = calls.find((c) => c.args[0] === 'build')?.args ?? [];
  return build.flatMap((arg, i) => (build[i - 1] === '--build-arg' ? [arg] : []));
}

it(
  '[F1-01j] the image is built with the playwright version of the lockfile, and the tag changes with it',
  () => {
    function fast(name: string, lock: string): Run {
      return run(['V3-01', '--worktree', workspace(name, lock), '--fast'], {
        STUB_DOCKER_FAIL: 'image-missing',
      });
    }
    const v163 = fast('pw-163', lockWithPlaywright('1.63.0'));
    expect(v163.status, v163.stderr).toBe(0);
    const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const pnpm = root.packageManager.replace('pnpm@', '');
    expect(buildArgs(v163.calls)).toEqual([`PNPM_VERSION=${pnpm}`, 'PLAYWRIGHT_VERSION=1.63.0']);
    const tag163 = builtImage(v163.calls) ?? '';
    expect(tag163).toMatch(/^couli-verify:[0-9a-f]{16}$/);
    // The run uses the image it built.
    expect(entrypointRun(v163.calls)?.args).toContain(tag163);

    // Same version, same image; another version or none, another image.
    const again = fast('pw-163-again', lockWithPlaywright('1.63.0'));
    expect(builtImage(again.calls)).toBe(tag163);
    const v164 = fast('pw-164', lockWithPlaywright('1.64.0'));
    expect(buildArgs(v164.calls)).toContain('PLAYWRIGHT_VERSION=1.64.0');
    const none = fast('pw-none', PLAIN_LOCK);
    expect(none.status, none.stderr).toBe(0);
    expect(buildArgs(none.calls)).toContain('PLAYWRIGHT_VERSION=none');
    const tags = [tag163, builtImage(v164.calls), builtImage(none.calls)];
    expect(new Set(tags).size).toBe(3);

    // Two versions in one lockfile: no guess, the run stops before Docker is asked anything.
    const two = fast(
      'pw-two',
      `${lockWithPlaywright('1.63.0')}\n  playwright@1.64.0:\n    resolution: {integrity: x}\n`,
    );
    expect(two.status).toBe(2);
    expect(two.stderr).toContain('more than one playwright version');
    expect(two.calls).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j, F1-01k] --browser: the browser projects only, no network, screenshots and reports exported to browser/<n>/out',
  () => {
    const ws = workspace('browser', lockWithPlaywright('1.63.0'));
    const res = run(['V3-02', '--worktree', ws, '--browser'], { STUB_DOCKER_RUN_EXIT: '1' });
    // Vitest's exit code is the result; result.json says browser.
    expect(res.status, res.stderr).toBe(1);
    const dir = join(runs, 'V3-02', 'browser', '1');
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
      mode: string;
      script: string;
      exit_code: number;
    };
    expect(result).toMatchObject({ mode: 'container', script: 'browser', exit_code: 1 });
    expect(existsSync(join(dir, 'out'))).toBe(true);
    // Writable and searchable for the container's uid, not listable, sticky (not 0777).
    expect(statSync(join(dir, 'out')).mode & 0o7777).toBe(0o1733);
    // The snapshot is not kept.
    expect(existsSync(join(dir, 'src'))).toBe(false);

    const { calls } = res;
    expect(calls.some((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const browser = entrypointRun(calls);
    const args = browser?.args ?? [];
    expect(args.slice(-2)).toEqual(['couli-verify-entrypoint', 'browser']);
    expect(valueOf(args, '--network')).toBe('none');
    // The output directory is the one writable mount besides the tmpfs; the snapshot and the
    // store stay read-only; no planning snapshot, no red reporter.
    const mounts = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []));
    expect(mounts).toEqual([
      expect.stringMatching(/\/V3-02\/browser\/1\/src:\/src:ro$/),
      expect.stringMatching(/^couli-stubtest-store-[0-9a-f]{16}:\/store:ro$/),
      expect.stringMatching(/\/V3-02\/browser\/1\/out:\/out$/),
    ]);
    // The hardening of every verify container.
    for (const flag of ['--init', '--read-only', 'no-new-privileges']) expect(args).toContain(flag);
    expect(valueOf(args, '--cap-drop')).toBe('ALL');
    // The projects come from the trusted table, in its order; nothing else is handed over.
    expect(browser?.env).toEqual({
      PROP_SEED: '20261001',
      VERIFY_TIMEOUT_SECS: '1200',
      BROWSER_PROJECTS:
        'spec-browser:test:vitest.browser.config.ts build-smoke:test:vitest.build-smoke.config.ts',
    });
    expect(noRedisUrl(browser)).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --browser: a green run that exported no screenshot fails; with screenshots it passes',
  () => {
    const lock = lockWithPlaywright('1.63.0');
    const empty = run(['V3-04', '--worktree', workspace('browser-empty', lock), '--browser']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('no screenshot was exported');
    const emptyDir = join(runs, 'V3-04', 'browser', '1');
    const result = JSON.parse(readFileSync(join(emptyDir, 'result.json'), 'utf8')) as {
      exit_code: number;
    };
    expect(result.exit_code).toBe(1);
    expect(readFileSync(join(emptyDir, 'log.txt'), 'utf8')).toContain(
      'browser tests exited 0; screenshots exported: 0',
    );

    const shots = run(['V3-05', '--worktree', workspace('browser-shots', lock), '--browser'], {
      STUB_DOCKER_SCREENSHOT: '1',
    });
    expect(shots.status, shots.stderr).toBe(0);
    const shotsDir = join(runs, 'V3-05', 'browser', '1');
    expect(readFileSync(join(shotsDir, 'log.txt'), 'utf8')).toContain(
      'browser tests exited 0; screenshots exported: 1 (browser tests 1, build smoke 0;',
    );

    // F1-01k: the build smoke's screenshots alone also count; the log tells the two kinds apart.
    const smoke = run(['V3-06', '--worktree', workspace('browser-smoke', lock), '--browser'], {
      STUB_DOCKER_SCREENSHOT: '1',
      STUB_DOCKER_SMOKE_SHOTS: '4',
    });
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(readFileSync(join(runs, 'V3-06', 'browser', '1', 'log.txt'), 'utf8')).toContain(
      'browser tests exited 0; screenshots exported: 5 (browser tests 1, build smoke 4;',
    );
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --red with integration and browser rule tests: two containers, the browser group stays offline',
  () => {
    const files = {
      'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
      'test/spec/identity/devices.browser.test.ts': "it('[BR-ID-05] z', () => {});\n",
    };
    const repo = redFixture('red-mixed', files, lockWithPlaywright('1.63.0'));
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main']);
    // The stub writes no report, so the run stops after the red containers (exit 2).
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for');
    const net =
      res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')?.args.at(-1) ?? '';
    // Other tests of this file ran B1-02b before: the run number is not 1.
    expect(net).toMatch(/^couli-stubtest-net-b1-02b-\d+-\d+$/);
    const reds = res.calls.filter((c) => c.args.includes('couli-verify-entrypoint'));
    expect(reds).toHaveLength(2);
    function groupsOf(call: Call | undefined): string[] {
      const plan = JSON.parse(call?.env['RED_PLAN'] ?? '{"groups":[]}') as {
        groups: { name: string }[];
      };
      return plan.groups.map((g) => g.name);
    }
    const db = reds.find((c) => groupsOf(c).includes('spec-int'));
    const offline = reds.find((c) => groupsOf(c).includes('spec-browser'));
    // The integration group alone on the internal network, with both service URLs.
    expect(groupsOf(db)).toEqual(['spec-int']);
    expect(valueOf(db?.args ?? [], '--network')).toBe(net);
    expect(db?.env['TEST_REDIS_URL']).toBe(REDIS_URL);
    expect(pgUrls(db)).toHaveLength(1);
    // The browser group alone with no network and no database URL of any kind.
    expect(groupsOf(offline)).toEqual(['spec-browser']);
    expect(valueOf(offline?.args ?? [], '--network')).toBe('none');
    expect(noRedisUrl(offline)).toBe(true);
    expect(pgUrls(offline)).toEqual([]);
    expect(Object.keys(offline?.env ?? {}).sort()).toEqual([
      'PROP_SEED',
      'RED_PLAN',
      'VERIFY_TIMEOUT_SECS',
    ]);
    // Two containers, two names; both are removed at the end.
    const names = reds.map((c) => valueOf(c.args, '--name') ?? '');
    expect(new Set(names).size).toBe(2);
    expect(res.calls.find((c) => c.args[0] === 'rm')?.args).toEqual(expect.arrayContaining(names));
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --browser on a lockfile without playwright stops (exit 2, no result) before Docker',
  () => {
    const res = run(['V3-03', '--worktree', workspace('browser-old'), '--browser']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--browser needs playwright in pnpm-lock.yaml');
    expect(res.calls).toEqual([]);
    expect(existsSync(join(runs, 'V3-03', 'browser', '1', 'result.json'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --red with a browser rule test: the spec-browser group runs without network; without playwright the run stops',
  () => {
    const files = {
      'test/spec/identity/devices.browser.test.ts': "it('[BR-ID-05] z', () => {});\n",
    };
    const res = run([
      'B1-02b',
      '--worktree',
      redFixture('red-browser', files, lockWithPlaywright('1.63.0')),
      '--red',
      '--base',
      'main',
    ]);
    // The stub writes no report, so the run stops after the red container (exit 2).
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for spec-browser');
    expect(res.calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const red = entrypointRun(res.calls);
    expect(red?.args.at(-1)).toBe('red');
    expect(valueOf(red?.args ?? [], '--network')).toBe('none');
    const plan = JSON.parse(red?.env['RED_PLAN'] ?? '{}') as { groups?: unknown };
    expect(plan.groups).toEqual([
      {
        name: 'spec-browser',
        dir: 'test',
        config: 'vitest.browser.config.ts',
        database: false,
        browser: true,
        files: ['spec/identity/devices.browser.test.ts'],
      },
    ]);

    const old = run([
      'B1-02b',
      '--worktree',
      redFixture('red-browser-old', files),
      '--red',
      '--base',
      'main',
    ]);
    expect(old.status).toBe(2);
    expect(old.stderr).toContain(
      'the red run has browser rule tests, but pnpm-lock.yaml has no playwright',
    );
    expect(entrypointRun(old.calls)).toBeUndefined();
  },
  CLI_TIMEOUT,
);

it('Redis has one image and one configuration in the verify container, CI and the local stack', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const compose = readFileSync(join(repoRoot(), 'infra', 'local', 'compose.yaml'), 'utf8');
  const ci = readFileSync(join(repoRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
  expect(script).toContain(`\nREDIS_IMAGE='${REDIS_IMAGE}'\n`);
  expect(compose).toContain(`    image: ${REDIS_IMAGE}\n`);
  expect(ci).toContain(`        image: ${REDIS_IMAGE}\n`);

  // infra/local/compose.yaml: the command list of the redis service.
  const list = /\n {2}redis:\n[\s\S]*?\n {4}command:\n((?: {6}- .*\n)+)/.exec(compose)?.[1] ?? '';
  const command = list
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^ {6}- /, '').replace(/^'(.*)'$/, '$1'));
  expect(command[0]).toBe('redis-server');
  expect(settings(command.slice(1))).toEqual(REDIS_SETTINGS);

  // CI: a service container takes no command; the same settings are applied with CONFIG SET.
  const configSet = /redis-cli CONFIG SET (.+?)\)"/.exec(ci)?.[1] ?? '';
  const words = configSet.split(' ').map((w) => (w === "''" ? '' : w));
  expect(settings(words)).toEqual(REDIS_SETTINGS);
  // The port is published on the loopback address only; the same step checks from the runner
  // that it answers PING there, and the integration tests get that address as TEST_REDIS_URL.
  expect(ci).toContain('          - 127.0.0.1:6379:6379\n');
  expect(ci).not.toMatch(/^ +- 6379:6379$/m);
  expect(ci).toContain('if exec 3<>/dev/tcp/127.0.0.1/6379; then\n');
  expect(ci).toContain("printf 'PING\\r\\n' >&3\n");
  expect(ci).toContain(`if [ "\${pong%$'\\r'}" != '+PONG' ]; then\n`);
  expect(ci).toContain(
    '      - run: pnpm test:int\n        env:\n          TEST_REDIS_URL: redis://127.0.0.1:6379/0\n',
  );
});

/** External services (the test machine): socket paths, the admin password file. */
function externalEnv(name: string, password: string): Record<string, string> {
  const dir = join(base, `ext-${name}`);
  // The script checks that the sockets exist; the stub never connects, so plain files do.
  writeFiles(dir, {
    'pg/.s.PGSQL.5432': '',
    'redis/redis.sock': '',
    'admin-password': `${password}\n`,
  });
  return {
    COULI_VERIFY_PG_SOCKET_DIR: join(dir, 'pg'),
    COULI_VERIFY_PG_ADMIN_USER: 'couli_test_admin',
    COULI_VERIFY_PG_ADMIN_PASSWORD_FILE: join(dir, 'admin-password'),
    COULI_VERIFY_REDIS_SOCKET: join(dir, 'redis', 'redis.sock'),
  };
}

/** `-v` mounts of a `docker run`. */
function mountsOf(args: readonly string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []));
}

const EXT_PASSWORD = 'p@ss/w0rd:x';
const EXT_PG_URL = `postgres://couli_test_admin:${encodeURIComponent(EXT_PASSWORD)}@127.0.0.1:5432/postgres`;

it(
  'external services: pnpm verify starts no service container and no network; the run reaches the host sockets through the proxy',
  () => {
    const env = externalEnv('verify', EXT_PASSWORD);
    const res = run(['V4-01', '--worktree', workspace('ext-verify')], {
      ...env,
      STUB_DOCKER_RUN_EXIT: '3',
    });
    expect(res.status, res.stderr).toBe(3);
    const dir = join(runs, 'V4-01', 'verify', '1');
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ mode: 'container', script: 'verify', exit_code: 3 });
    expect(result['services']).toBe('external');

    const { calls } = res;
    expect(calls.some((c) => c.args[0] === 'network')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    expect(containerRuns(calls, PG_IMAGE)).toEqual([]);
    expect(containerRuns(calls, REDIS_IMAGE)).toEqual([]);

    // Cleaning before and after: psql and node of the verify image, no network, sockets read-only,
    // the password by name only.
    const resets = calls.filter((c) => (valueOf(c.args, '--name') ?? '').includes('-reset-'));
    expect(resets).toHaveLength(2);
    for (const reset of resets) {
      expect(valueOf(reset.args, '--network')).toBe('none');
      expect(mountsOf(reset.args)).toEqual([
        `${env['COULI_VERIFY_PG_SOCKET_DIR'] ?? ''}:/run/couli-pg:ro`,
        `${dirname(env['COULI_VERIFY_REDIS_SOCKET'] ?? '')}:/run/couli-redis:ro`,
      ]);
      expect(reset.env['PGPASSWORD']).toBe(EXT_PASSWORD);
      expect(reset.args).not.toContain(`PGPASSWORD=${EXT_PASSWORD}`);
      expect(reset.args.join(' ')).toContain('FLUSHALL');
    }
    expect(resets.map((c) => c.env['RESET_PHASE'])).toEqual(['before', 'after']);

    const verifyAt = calls.findIndex((c) => c.args.includes('couli-verify-entrypoint'));
    const verify = calls[verifyAt];
    expect(calls.indexOf(resets[0] as Call)).toBeLessThan(verifyAt);
    expect(calls.indexOf(resets[1] as Call)).toBeGreaterThan(verifyAt);
    const args = verify?.args ?? [];
    expect(args.slice(-2)).toEqual(['couli-verify-entrypoint', 'verify']);
    expect(valueOf(args, '--network')).toBe('none');
    // The wrapper starts the proxy, then execs the entrypoint.
    expect(args.slice(-5, -2)).toEqual([
      '-c',
      expect.stringContaining('exec "$@"'),
      'couli-services',
    ]);
    expect(mountsOf(args)).toEqual([
      `${env['COULI_VERIFY_PG_SOCKET_DIR'] ?? ''}:/run/couli-pg:ro`,
      `${dirname(env['COULI_VERIFY_REDIS_SOCKET'] ?? '')}:/run/couli-redis:ro`,
      expect.stringMatching(
        /\/V4-01\/verify\/1\/services-proxy\.cjs:\/couli-services\/proxy\.cjs:ro$/,
      ),
      expect.stringMatching(/\/V4-01\/verify\/1\/src:\/src:ro$/),
      expect.stringMatching(/^couli-stubtest-store-[0-9a-f]{16}:\/store:ro$/),
    ]);
    for (const flag of ['--init', '--read-only', 'no-new-privileges']) expect(args).toContain(flag);
    expect(JSON.parse(verify?.env['COULI_SERVICES_ROUTES'] ?? '[]')).toEqual([
      [5432, '/run/couli-pg/.s.PGSQL.5432'],
      [6379, '/run/couli-redis/redis.sock'],
    ]);
    // The admin URL (found by its value, passed by name) and the Redis URL point at the proxy.
    expect(Object.values(verify?.env ?? {})).toContain(EXT_PG_URL);
    expect(args.some((a) => a.includes(encodeURIComponent(EXT_PASSWORD)))).toBe(false);
    expect(verify?.env['TEST_REDIS_URL']).toBe('redis://127.0.0.1:6379/0');

    // The password is in no log; the proxy file and the lock are gone afterwards.
    for (const text of [res.stdout, res.stderr, readFileSync(join(dir, 'log.txt'), 'utf8')]) {
      expect(text).not.toContain(EXT_PASSWORD);
      expect(text).not.toContain(encodeURIComponent(EXT_PASSWORD));
    }
    expect(existsSync(join(dir, 'services-proxy.cjs'))).toBe(false);
    expect(existsSync(join(runs, 'lock', 'verify-external-services'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  'external services: --fast and a unit-only --red touch none of them; an integration --red group gets them',
  () => {
    const env = externalEnv('red', EXT_PASSWORD);
    const fast = run(['V4-02', '--worktree', workspace('ext-fast'), '--fast'], env);
    expect(fast.status, fast.stderr).toBe(0);
    expect(fast.calls.some((c) => (valueOf(c.args, '--name') ?? '').includes('-reset-'))).toBe(
      false,
    );
    const fastRun = entrypointRun(fast.calls);
    expect(mountsOf(fastRun?.args ?? []).some((m) => m.includes('/run/couli-'))).toBe(false);
    const fastResult = JSON.parse(
      readFileSync(join(runs, 'V4-02', 'verify-fast', '1', 'result.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(fastResult['services']).toBeUndefined();

    const unit = run(
      [
        'B1-02b',
        '--worktree',
        redFixture('ext-red-unit', {
          'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
        }),
        '--red',
        '--base',
        'main',
      ],
      env,
    );
    expect(unit.status).toBe(2);
    expect(unit.calls.some((c) => (valueOf(c.args, '--name') ?? '').includes('-reset-'))).toBe(
      false,
    );
    expect(noRedisUrl(entrypointRun(unit.calls))).toBe(true);

    const int = run(
      [
        'B1-02b',
        '--worktree',
        redFixture('ext-red-int', {
          'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
        }),
        '--red',
        '--base',
        'main',
      ],
      env,
    );
    // The stub writes no report, so the run stops after the red container (exit 2); the cleanup
    // after the run still happens and the lock is released.
    expect(int.status).toBe(2);
    expect(int.stderr).toContain('wrote no report for spec-int');
    expect(int.calls.some((c) => c.args[0] === 'network')).toBe(false);
    expect(containerRuns(int.calls, PG_IMAGE)).toEqual([]);
    const red = entrypointRun(int.calls);
    expect(red?.args.slice(-2)).toEqual(['couli-verify-entrypoint', 'red']);
    expect(valueOf(red?.args ?? [], '--network')).toBe('none');
    expect(Object.values(red?.env ?? {})).toContain(EXT_PG_URL);
    expect(red?.env['TEST_REDIS_URL']).toBe('redis://127.0.0.1:6379/0');
    const resets = int.calls.filter((c) => (valueOf(c.args, '--name') ?? '').includes('-reset-'));
    expect(resets.map((c) => c.env['RESET_PHASE'])).toEqual(['before', 'after']);
    expect(existsSync(join(runs, 'lock', 'verify-external-services'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  'external services: an incomplete setting or a missing socket stops the run (exit 2) before any test runs',
  () => {
    const env = externalEnv('broken', EXT_PASSWORD);
    const partial = run(['V4-03', '--worktree', workspace('ext-partial')], {
      COULI_VERIFY_PG_SOCKET_DIR: env['COULI_VERIFY_PG_SOCKET_DIR'] ?? '',
    });
    expect(partial.status).toBe(2);
    expect(partial.stderr).toContain('external services need');
    expect(partial.calls).toEqual([]);

    const missing = run(['V4-04', '--worktree', workspace('ext-missing')], {
      ...env,
      COULI_VERIFY_REDIS_SOCKET: join(base, 'no-such-dir', 'redis.sock'),
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no Redis socket');
    expect(entrypointRun(missing.calls)).toBeUndefined();
    expect(existsSync(join(runs, 'V4-04', 'verify', '1', 'result.json'))).toBe(false);
    // The run never took the lock.
    expect(existsSync(join(runs, 'lock', 'verify-external-services'))).toBe(false);
  },
  CLI_TIMEOUT,
);
