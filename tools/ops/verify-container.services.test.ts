// The docker commands verify-container.sh issues for the one-shot services (PostgreSQL, Redis):
// a stub `docker` first on PATH records every call and answers like a healthy daemon, so the
// plan — what starts on which network with which settings, what the verify container receives,
// what is removed at the end — is checked without Docker. Whether the real images behave is the
// job of tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
// exit code of the verify / red container.
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
if (args[0] === 'run' && args.includes('-d')) {
  if (failures.includes('redis-start') && aboutRedis) {
    process.stderr.write('stub: cannot start the container\n');
    process.exit(125);
  }
  answer('0123456789ab', 0);
}
if (args[0] === 'run' && args.includes('couli-verify-entrypoint')) {
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

/** A workspace the container path accepts (pinned pnpm, lockfile, workspace file). */
function workspace(name: string): string {
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
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
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
function redFixture(name: string, files: Record<string, string>): string {
  const repo = workspace(name);
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
