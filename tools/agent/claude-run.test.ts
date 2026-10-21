// Tests for claude-run.sh (owner decision 2026-10-21, ops/approvals.yaml id 36): rule tests and
// reviews by a fresh, independent Claude context when Codex is not available. They spawn bash with
// a fake claude selected through COULI_CLAUDE_BIN; the real claude is never started.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  FAKE_CLAUDE,
  type Fixture,
  makeFixture,
  observed,
  observedArgv,
  readJson,
  runScript,
  stubCalls,
  TASK,
  writeStub,
} from './testing/fixture.ts';

const LONG = { timeout: 60_000 };
const fixtures: Fixture[] = [];

/** A fixture whose wrapper finds the fake claude (and no task ledger unless one is stubbed). */
function fixture(name: string): Fixture {
  const fx = makeFixture(`claude-${name}`);
  fx.env['COULI_CLAUDE_BIN'] = FAKE_CLAUDE;
  fixtures.push(fx);
  return fx;
}

const extraDirs: string[] = [];

afterEach(() => {
  for (const fx of fixtures.splice(0)) fx.cleanup();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claudeRun(fx: Fixture, args: readonly string[], extraEnv: Record<string, string> = {}) {
  return runScript('claude-run.sh', args, fx.env, extraEnv);
}

/** The trusted ledger as `task.ts show --json` prints it. */
function ledger(fx: Fixture, fields: Record<string, unknown>): void {
  writeStub(join(fx.trusted, 'tools', 'ops', 'task.ts'), 'task', [
    {
      when: ['show'],
      stdout: JSON.stringify({
        id: TASK,
        type: 'impl',
        risk: 'RV1',
        impl: 'claude',
        tester: 'claude-independent',
        paths: ['src/a.ts'],
        test_paths: ['test/spec/t1/**', 'test/{acceptance,properties}/t1/**'],
        refs: ['BR-CALC-01'],
        ...fields,
      }),
    },
  ]);
}

/** Decodes the `--dry-run` listing: one argument per line, `\n` and `\\` escaped. */
function decodeDryRun(stdout: string): string[] {
  return stdout
    .split('\n')
    .slice(0, -1)
    .map((line) => line.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\')));
}

/** The value after `flag` in an argv, and the values of a variadic flag up to the next option. */
function after(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function variadic(argv: readonly string[], flag: string): string[] {
  const at = argv.indexOf(flag);
  const out: string[] = [];
  for (let i = at + 1; i > 0 && i < argv.length && !(argv[i] ?? '').startsWith('--'); i++) {
    out.push(argv[i] ?? '');
  }
  return out;
}

it(
  '[approvals 36] test phase: a fresh claude -p context with fixed tools, edit rules and the trusted schema',
  LONG,
  () => {
    const fx = fixture('impl');
    ledger(fx, {});
    const res = claudeRun(fx, ['impl', TASK]);
    expect(res.status, res.stderr).toBe(0);
    const argv = observedArgv(fx);
    // A new session every time: print mode, never resumed, nothing persisted, no configuration.
    expect(argv[0]).toBe('-p');
    for (const flag of [
      '--no-session-persistence',
      '--safe-mode',
      '--restricted',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--verbose',
      '--include-partial-messages',
    ]) {
      expect(argv).toContain(flag);
    }
    for (const flag of ['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id']) {
      expect(argv).not.toContain(flag);
    }
    expect(after(argv, '--model')).toBe('claude-opus-5-5');
    expect(after(argv, '--output-format')).toBe('stream-json');
    expect(after(argv, '--permission-mode')).toBe('dontAsk');
    expect(after(argv, '--tools')).toBe('Read,Grep,Glob,Edit,Write,Bash');
    expect(after(argv, '--json-schema')).toBe(
      readFileSync(
        join(fx.trusted, 'tools', 'agent', 'schemas', 'impl.schema.json'),
        'utf8',
      ).replace(/\n$/, ''),
    );
    // Edits only inside test_paths (braces expanded) and the skeleton paths; static checks only.
    const rules = variadic(argv, '--allowedTools');
    expect(rules).toEqual(
      expect.arrayContaining([
        'Read',
        'Bash(git diff:*)',
        'Bash(pnpm exec tsc:*)',
        'Edit(/test/spec/t1/**)',
        'Edit(/test/acceptance/t1/**)',
        'Edit(/test/properties/t1/**)',
        'Edit(/src/a.ts)',
      ]),
    );
    expect(rules.filter((r) => r.startsWith('Edit(')).length).toBe(4);
    expect(rules.some((r) => r === 'Bash' || r.startsWith('Bash(pnpm test') || r === 'Edit')).toBe(
      false,
    );
    // The prompt is the brief, last; claude starts in the worktree with stdin closed.
    expect(argv[argv.length - 1]).toBe(
      readFileSync(join(fx.run, 'brief.md'), 'utf8').replace(/\n+$/, ''),
    );
    expect(observed(fx)).toMatchObject({ cwd: fx.worktree, stdin: 'devnull', wrapper: '1' });
    // Same run directory and meta.json as codex-run.sh, recorded as the independent Claude engine.
    const meta = readJson(join(fx.run, 'meta.impl.json'));
    expect(meta).toMatchObject({
      mode: 'impl',
      phase: 'test',
      engine: 'claude-independent',
      model: 'claude-opus-5-5',
      exit_code: 0,
      agent_exit: 0,
      has_output: true,
      validation: 'ok',
      last_event: 'result.success',
      thread_id: '5e55f4ke-0000-4000-8000-000000000001',
      timeout_secs: 1800,
      idle_secs: 300,
    });
    expect(meta).not.toHaveProperty('codex_exit');
    expect(meta).not.toHaveProperty('codex_version');
    expect(readJson(join(fx.run, 'impl.json'))).toMatchObject({ task_done: true });
    // The Codex token ledger is not written for a Claude call.
    expect(stubCalls(fx, 'usage')).toEqual([]);
  },
);

it(
  '[approvals 36] review: read-only tools, the review output under its own name, engine recorded',
  LONG,
  () => {
    const fx = fixture('review');
    ledger(fx, { risk: 'RV2', tester: 'codex' });
    writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const outputFile = join(fx.root, 'money-review.json');
    writeFileSync(
      outputFile,
      JSON.stringify({
        verdict: 'pass',
        summary: 'nothing found',
        findings: [],
        out_of_scope: [],
        checklist: [
          'rounding',
          'sign',
          'idempotency',
          'concurrency',
          'partial_refund',
          'clock',
          'app_id',
        ].map((item) => ({ item, status: 'na', file: 'src/a.ts', line: 1, note: 'n/a' })),
      }),
    );
    const res = claudeRun(fx, ['review', TASK, '--base', fx.baseSha], {
      FAKE_CLAUDE_OUTPUT_FILE: outputFile,
    });
    expect(res.status, res.stderr).toBe(0);
    const argv = observedArgv(fx);
    expect(after(argv, '--tools')).toBe('Read,Grep,Glob,Bash');
    const rules = variadic(argv, '--allowedTools');
    expect(rules.some((r) => r.startsWith('Edit('))).toBe(false);
    expect(rules.some((r) => r.includes('tsc') || r.includes('eslint'))).toBe(false);
    // RV2 defaults to the money review; the prompt is the trusted file plus the context block,
    // which says who wrote what.
    const prompt = argv[argv.length - 1] ?? '';
    expect(
      prompt.startsWith(
        readFileSync(join(fx.trusted, 'tools/agent/prompts/review-money.md'), 'utf8'),
      ),
    ).toBe(true);
    expect(prompt).toContain('generated by claude-run.sh');
    expect(prompt).toContain('independent Claude context (claude-independent)');
    expect(prompt).toContain('ledger rule-test author: codex');
    expect(existsSync(join(fx.run, 'review-claude-independent.json'))).toBe(true);
    expect(existsSync(join(fx.run, 'review-codex.json'))).toBe(false);
    expect(readJson(join(fx.run, 'meta.review.json'))).toMatchObject({
      mode: 'review',
      review_type: 'money',
      engine: 'claude-independent',
      exit_code: 0,
      validation: 'ok',
    });
  },
);

it(
  '[approvals 36] a usage limit or rejected rate limit gives exit 11; quoted text does not',
  LONG,
  () => {
    const fx = fixture('limit');
    ledger(fx, {});
    const limited = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: 'usage-limit' });
    expect(limited.status).toBe(11);
    expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({
      exit_code: 11,
      capacity_error: true,
      has_output: false,
      last_event: 'result.error',
    });
    const quoted = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: 'quoting-limit' });
    expect(quoted.status).toBe(10);
    expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({ capacity_error: false });
    // The previous call's files went to attempts/<n>/.
    expect(existsSync(join(fx.run, 'attempts', '1', 'meta.json'))).toBe(true);
  },
);

it(
  '[approvals 36] no final result, or a result without structured output, gives exit 10',
  LONG,
  () => {
    const fx = fixture('noresult');
    ledger(fx, {});
    for (const scenario of ['no-result', 'no-structured-output']) {
      const res = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: scenario });
      expect(res.status, scenario).toBe(10);
      expect(existsSync(join(fx.run, 'impl.json')), scenario).toBe(false);
      expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({
        has_output: false,
        validation: 'not-run',
      });
    }
  },
);

it('[approvals 36] a review that leaves a file in the working tree gives exit 12', LONG, () => {
  const fx = fixture('dirty');
  ledger(fx, {});
  const res = claudeRun(fx, ['review', TASK, '--base', fx.baseSha], {
    FAKE_CLAUDE_SCENARIO: 'write-untracked',
  });
  expect(res.status).toBe(12);
  expect(readJson(join(fx.run, 'meta.review.json'))['position_changed']).toEqual(['worktree']);
  expect(existsSync(join(fx.run, 'review-claude-independent.json'))).toBe(false);
});

it(
  '[approvals 36] refused: other phases, a ledger that does not name claude-independent, resumed or bypassed sessions',
  LONG,
  () => {
    const fx = fixture('refuse');
    ledger(fx, {});
    for (const phase of ['handover', 'impl']) {
      const res = claudeRun(fx, ['impl', TASK, '--phase', phase, '--dry-run']);
      expect(res.status, phase).toBe(2);
      expect(res.stderr).toContain('writes rule tests only');
    }
    ledger(fx, { tester: 'codex' });
    const codexTester = claudeRun(fx, ['impl', TASK, '--dry-run']);
    expect(codexTester.status).toBe(2);
    expect(codexTester.stderr).toContain('not claude-independent');
    ledger(fx, { test_paths: [] });
    expect(claudeRun(fx, ['impl', TASK, '--dry-run']).stderr).toContain('has no test_paths');
    for (const value of ['--continue', 'bypassPermissions', '--dangerously-skip-permissions']) {
      const res = claudeRun(fx, ['impl', TASK, '--worktree', value]);
      expect(res.status, value).toBe(2);
    }
    // A replacement claude is for test fixtures only.
    const real = claudeRun(fx, ['impl', TASK, '--dry-run'], { COULI_AGENT_TEST: '0' });
    expect(real.status).toBe(2);
    expect(real.stderr).toContain('COULI_CLAUDE_BIN is set but COULI_AGENT_TEST=1 is not');
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
  },
);

it(
  '[approvals 36] spec-test review of any known author; an unknown author is refused',
  LONG,
  () => {
    const fx = fixture('spec');
    const args = ['review', TASK, '--base', fx.baseSha, '--review-type', 'spec-test', '--dry-run'];
    for (const tester of ['codex', 'claude', 'claude-independent']) {
      ledger(fx, { tester });
      const res = claudeRun(fx, args);
      expect(res.status, `${tester}: ${res.stderr}`).toBe(0);
    }
    ledger(fx, { tester: undefined });
    const unknown = claudeRun(fx, args);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('the rule-test author is unknown');
    // A Codex handover implementation may be reviewed by an independent Claude context.
    writeStub(join(fx.trusted, 'tools', 'ops', 'state.ts'), 'state', [
      { when: ['get'], stdout: JSON.stringify({ implementer: 'codex' }) },
    ]);
    ledger(fx, { risk: 'RV1' });
    expect(claudeRun(fx, ['review', TASK, '--base', fx.baseSha, '--dry-run']).status).toBe(0);
  },
);

it(
  '[approvals 36] the account is CLAUDE_INDEPENDENT_CONFIG_DIR; API keys never reach the child',
  LONG,
  () => {
    const fx = fixture('account');
    ledger(fx, {});
    // Outside the repository, the trusted root and the run-state directory (the fixture lives in
    // REPO/.tmp, so the account directory cannot).
    const account = realpathSync(mkdtempSync(join(tmpdir(), 'couli-claude-account-')));
    extraDirs.push(account);
    const res = claudeRun(fx, ['impl', TASK], {
      CLAUDE_INDEPENDENT_CONFIG_DIR: account,
      ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(observed(fx)).toMatchObject({ config_dir: account, api_key: '' });
    expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({ config_dir: account });
    // Unset: the caller's CLAUDE_CONFIG_DIR is kept.
    const inherited = claudeRun(fx, ['impl', TASK], { CLAUDE_CONFIG_DIR: account });
    expect(inherited.status, inherited.stderr).toBe(0);
    expect(observed(fx)).toMatchObject({ config_dir: account });
    // Relative, missing, inside the run-state directory or the repository: refused before claude
    // starts.
    for (const bad of ['relative/dir', join(account, 'missing'), fx.run, fx.trusted]) {
      expect(
        claudeRun(fx, ['impl', TASK, '--dry-run'], { CLAUDE_INDEPENDENT_CONFIG_DIR: bad }).status,
        bad,
      ).toBe(2);
    }
  },
);

it('[approvals 36] codex-run.sh ignores AGENT_ENGINE from the environment', LONG, () => {
  const fx = fixture('engine-env');
  const res = runScript('codex-run.sh', ['impl', TASK, '--dry-run'], fx.env, {
    AGENT_ENGINE: 'claude-independent',
  });
  expect(res.status, res.stderr).toBe(0);
  const argv = decodeDryRun(res.stdout);
  expect(argv[1]).toBe('exec');
  expect(argv).toContain('gpt-6-astra');
});

it('[approvals 36] selfcheck reads claude --help and starts no Claude turn', LONG, () => {
  const fx = fixture('selfcheck');
  const res = claudeRun(fx, ['selfcheck']);
  expect(res.status, res.stdout + res.stderr).toBe(0);
  expect(res.stdout).toContain('ok    claude --help lists --json-schema');
  expect(res.stdout).toContain('ok    prompt review-spec-test.md');
  expect(res.stdout).toContain('selfcheck: ok (no Claude turn was started)');
  expect(res.stdout).toContain('claude-opus-5-5');
  expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
  const missing = claudeRun(fx, ['selfcheck'], { FAKE_CLAUDE_SCENARIO: 'help-missing-flag' });
  expect(missing.status).toBe(1);
  expect(missing.stdout).toContain('FAIL  claude --help does not list --json-schema');
});
