// Unit tests for the parts of verify-container.sh that need neither Docker nor
// the network. The container path itself is exercised by
// tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

let base = '';
let runs = '';

function fixture(name: string, verify: string): string {
  const dir = join(base, name);
  writeFiles(dir, {
    'package.json': `${JSON.stringify({ name, private: true, scripts: { verify } }, null, 2)}\n`,
    'pnpm-workspace.yaml': 'packages: []\n',
  });
  return dir;
}

function run(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COULI_RUNS: runs, COULI_TRUSTED_ROOT: repoRoot(), ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

type Result = {
  mode: string;
  exit_code: number;
  commit: string | null;
  tree: string | null;
  prop_seed: number;
  started_at: string;
  finished_at: string;
};
const result = (id: string, n: number): Result =>
  JSON.parse(readFileSync(join(runs, id, 'verify', String(n), 'result.json'), 'utf8')) as Result;

beforeAll(() => {
  base = scratchDir('verify');
  runs = join(base, 'runs');
});
afterAll(() => removeDir(base));

it(
  'the scripts are valid bash and perl',
  () => {
    for (const file of [
      'verify-container.sh',
      'verify-container.selftest.sh',
      'verify-image/entrypoint.sh',
    ]) {
      expect(spawnSync('bash', ['-n', join(OPS_DIR, file)]).status).toBe(0);
    }
    expect(spawnSync('perl', ['-c', join(OPS_DIR, 'timeout-group.pl')]).status).toBe(0);
  },
  CLI_TIMEOUT,
);

it('the image default pnpm version equals the root packageManager', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const dockerfile = readFileSync(join(OPS_DIR, 'verify-image', 'Dockerfile'), 'utf8');
  expect(dockerfile).toContain(`ARG PNPM_VERSION=${pkg.packageManager.replace('pnpm@', '')}\n`);
  expect(dockerfile).toContain('FROM node:24-bookworm-slim\n');
  expect(dockerfile).toContain('USER node\n');
  expect(dockerfile).not.toMatch(/corepack enable/);
});

it(
  'refuses bad usage and worktrees under the temp directories',
  () => {
    expect(run([]).status).toBe(2);
    expect(run(['../x', '--host']).stderr).toContain('invalid task id');
    expect(run(['V1-01', '--bogus']).status).toBe(2);
    expect(run(['V1-01', '--worktree', join(base, 'missing'), '--host']).stderr).toContain(
      'worktree does not exist',
    );
    const inTmp = mkdtempSync(join(tmpdir(), 'couli-verify-test-'));
    try {
      writeFileSync(join(inTmp, 'package.json'), '{"scripts":{"verify":"true"}}\n');
      const res = run(['V1-01', '--worktree', inTmp, '--host']);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('refusing a worktree under');
    } finally {
      rmSync(inTmp, { recursive: true, force: true });
    }
    // Nothing was recorded for the refused runs.
    expect(existsSync(join(runs, 'V1-01'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  'refuses to run from a checkout that is not the trusted root',
  () => {
    const res = run(['V1-02', '--worktree', fixture('untrusted', 'true'), '--host'], {
      COULI_TRUSTED_ROOT: base,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('run this script from the trusted root');
  },
  CLI_TIMEOUT,
);

it(
  'host mode records the exit code, the seed and the mode',
  () => {
    const ok = fixture(
      'host-ok',
      // A clean environment: replaced HOME, no inherited secrets, seed passed through.
      "node -e \"const e=process.env; process.exit(e.HOME.endsWith('/V1-03/home') && !e.GH_TOKEN && !e.SSH_AUTH_SOCK && e.PROP_SEED==='77' ? 0 : 9)\"",
    );
    const pass = run(['V1-03', '--worktree', ok, '--host'], {
      GH_TOKEN: 'not-a-real-token',
      SSH_AUTH_SOCK: '/nonexistent/agent.sock',
      PROP_SEED: '77',
    });
    expect(pass.status).toBe(0);
    const first = result('V1-03', 1);
    expect(first).toMatchObject({
      mode: 'host',
      exit_code: 0,
      commit: null,
      tree: null,
      prop_seed: 77,
    });
    expect(JSON.parse(pass.stdout)).toEqual(first);
    expect(Date.parse(first.finished_at)).toBeGreaterThanOrEqual(Date.parse(first.started_at));
    expect(readFileSync(join(runs, 'V1-03', 'verify', '1', 'log.txt'), 'utf8')).toContain(
      '> node -e',
    );

    const bad = fixture('host-fail', 'node -e "process.exit(7)"');
    expect(run(['V1-03', '--worktree', bad, '--host']).status).toBe(7);
    // Runs are numbered; the default seed is the fixed one.
    expect(result('V1-03', 2)).toMatchObject({ mode: 'host', exit_code: 7, prop_seed: 20261001 });
    expect(readdirSync(join(runs, 'V1-03', 'verify')).sort()).toEqual(['1', '2']);
  },
  CLI_TIMEOUT,
);

it(
  'host mode kills the whole process group at the time limit and reports 124',
  () => {
    const slow = fixture('host-slow', 'node -e "setTimeout(() => {}, 600000)"');
    const res = run(['V1-04', '--worktree', slow, '--host'], {
      COULI_VERIFY_TIMEOUT_SECS: '1',
      COULI_KILL_GRACE_SECS: '2',
    });
    expect(res.status).toBe(124);
    expect(result('V1-04', 1).exit_code).toBe(124);
  },
  CLI_TIMEOUT,
);

it(
  'records the commit and the tree of the worktree as verified',
  () => {
    const repo = fixture('host-git', 'node -e "process.exit(0)"');
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
    const headTree = fixtureGit(repo, ['rev-parse', 'HEAD^{tree}']);

    expect(run(['V1-05', '--worktree', repo, '--host']).status).toBe(0);
    expect(result('V1-05', 1)).toMatchObject({ commit: head, tree: headTree });

    // Uncommitted work changes the tree, not the commit; the real index stays untouched.
    writeFileSync(join(repo, 'new-file.txt'), 'uncommitted\n');
    expect(run(['V1-05', '--worktree', repo, '--host']).status).toBe(0);
    const dirty = result('V1-05', 2);
    expect(dirty.commit).toBe(head);
    expect(dirty.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(dirty.tree).not.toBe(headTree);
    expect(fixtureGit(repo, ['status', '--porcelain'])).toBe('?? new-file.txt');
  },
  CLI_TIMEOUT,
);
