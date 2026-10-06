import { afterAll, beforeAll, expect, it } from 'vitest';
import { listTaskIds, loadTask } from '../lib/task-file.ts';
import { ruleHash, findRuleInText } from './spec.ts';
import {
  batchRisk,
  checkTask,
  checkTasks,
  computeRefsHash,
  MAX_TASK_LINES,
  showTask,
} from './task.ts';
import type { CheckOptions, RiskReport } from './task.ts';
import {
  CLI_TIMEOUT,
  fixedRisk,
  memorySpec,
  removeDir,
  runCli,
  scratchDir,
  taskYaml,
  writeFiles,
} from './test-helpers.ts';

const RULES = [
  '| 编号 | 规则 | 状态 | 影响面 |',
  '| --- | --- | --- | --- |',
  '| BR-DEMO-01 | **演示规则**<br>金额用整数分 | 已确认 | packages/demo |',
  '',
  '#### BR-DEMO-01 细则 · 演示规则',
  '',
  '- 状态：已确认',
  '- 例：1 分',
  '',
].join('\n');
const PLAN = [
  '| 任务 | 内容 |',
  '| --- | --- |',
  '| X1-01 | 演示任务 |',
  '| X1-02 | 第二个 |',
  '',
].join('\n');
const spec = memorySpec({
  '规划/08_业务规则/01_DEMO.md': RULES,
  '规划/05_里程碑与任务拆分.md': PLAN,
});
const demoRule = findRuleInText(RULES, 'BR-DEMO-01', 'demo.md');
const HASH = demoRule ? ruleHash(demoRule) : '';
const good = (fields: Record<string, string> = {}): string =>
  taskYaml({ refs_hash: `\n  BR-DEMO-01: ${HASH}`, ...fields });

let root = '';
const opts = (risk: 'RV0' | 'RV1' | 'RV2' = 'RV2'): CheckOptions => ({
  root,
  spec,
  risk: fixedRisk(risk),
});

beforeAll(() => {
  root = scratchDir('task');
  writeFiles(root, {
    'ops/tasks/X1-01.yaml': good(),
    'ops/tasks/X1-01a.yaml': good({ id: 'X1-01a', deps: '[X1-01, X1-02]' }),
    'ops/tasks/archive/202609/X1-02.yaml': good({ id: 'X1-02', status: 'done' }),
    'ops/tasks/X1-01b.yaml': good({ id: 'X1-01b', refs_hash: '\n  BR-DEMO-01: aaaaaaaaaaaa' }),
    'ops/tasks/X1-01c.yaml': good({ id: 'X1-01c', refs: '[BR-DEMO-01, BR-DEMO-07]' }),
    'ops/tasks/X9-01.yaml': good({ id: 'X9-01' }),
    'ops/tasks/X1-01d.yaml': good({ id: 'X1-01d', deps: '[X1-77]' }),
    'ops/tasks/X1-01e.yaml': good({ id: 'X1-01e', tester: 'codex' }),
    'ops/tasks/X1-01f.yaml': good({ id: 'X1-01f', tester: 'none' }),
    'ops/tasks/X1-01g.yaml': `${good({ id: 'X1-01g' })}${'# padding\n'.repeat(MAX_TASK_LINES)}`,
    'ops/tasks/X1-01h.yaml': good({ id: 'X1-01zz' }),
    'ops/tasks/X1-01i.yaml': good({ id: 'X1-01i', type: 'feature', paths: '[]' }),
    'ops/tasks/X1-01j.yaml': good({ id: 'X1-01j', refs_hash: '{}' }),
    // The fixture's switch-baseline ledgers: these may omit test_paths (CR2-02).
    'tools/guard/legacy-tasks.json': JSON.stringify({
      baseline: 'fixture',
      tasks: [
        'X1-01',
        'X1-01a',
        'X1-01b',
        'X1-01c',
        'X1-01d',
        'X1-01e',
        'X1-01f',
        'X1-01g',
        'X1-01h',
        'X1-01i',
        'X1-01j',
        'X1-02',
        'X9-01',
      ],
    }),
  });
});

afterAll(() => removeDir(root));

it('accepts a valid task and a split task whose dependency is archived', () => {
  expect(checkTask('X1-01', opts())).toEqual([]);
  expect(checkTask('X1-01a', opts())).toEqual([]);
  expect(computeRefsHash(['BR-DEMO-01'], spec)).toEqual({ 'BR-DEMO-01': HASH });
});

it('flags a stale hash, an unknown reference and a missing hash entry', () => {
  expect(checkTask('X1-01b', opts()).join('\n')).toMatch(
    new RegExp(`BR-DEMO-01 is aaaaaaaaaaaa but the text at SPEC_REF hashes to ${HASH}`),
  );
  expect(checkTask('X1-01c', opts()).join('\n')).toMatch(/BR-DEMO-07: not found/);
  expect(checkTask('X1-01j', opts()).join('\n')).toMatch(/refs_hash: missing entry for BR-DEMO-01/);
});

it('flags an id that 规划/05 does not know and a missing dependency', () => {
  expect(checkTask('X9-01', opts())).toEqual([
    'task id prefix X9-01 is not a task row of 规划/05 at SPEC_REF',
  ]);
  expect(checkTask('X1-01d', opts())).toEqual(['deps: X1-77 is not in ops/tasks']);
});

it('requires another model as rule-test author for RV2 implementation work', () => {
  expect(checkTask('X1-01e', opts('RV2')).join('\n')).toMatch(/tester: must differ from impl/);
  expect(checkTask('X1-01f', opts('RV2')).join('\n')).toMatch(/RV2 tasks need a rule-test author/);
  expect(checkTask('X1-01e', opts('RV1'))).toEqual([]);
  expect(checkTask('X1-01f', opts('RV0'))).toEqual([]);
});

it('flags the line limit, a wrong file name and shape errors', () => {
  expect(checkTask('X1-01g', opts()).join('\n')).toMatch(/lines, the limit is 40/);
  expect(checkTask('X1-01h', opts()).join('\n')).toMatch(/does not match the file name/);
  const shape = checkTask('X1-01i', opts()).join('\n');
  expect(shape).toMatch(/type: must be one of/);
  expect(shape).toMatch(/paths: must not be empty/);
});

it('checks every file of the ledger and reports the failing ones', () => {
  const results = checkTasks([], opts());
  const failed = results.filter((r) => r.problems.length > 0).map((r) => r.id);
  expect(results).toHaveLength(12);
  expect(failed).toEqual([
    'X1-01b',
    'X1-01c',
    'X1-01d',
    'X1-01e',
    'X1-01f',
    'X1-01g',
    'X1-01h',
    'X1-01i',
    'X1-01j',
    'X9-01',
  ]);
  expect(checkTasks(['X1-99'], opts())[0]?.problems).toEqual([
    'ops/tasks/X1-99.yaml does not exist',
  ]);
});

it('[ops/approvals.yaml id 19] test_paths stay inside the rule-test assets of a task with a tester', () => {
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**', 'specs/commission-examples.csv'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    // A new ledger (not on the switch-baseline list) with a rule-test author and no test_paths.
    'ops/tasks/X1-01n.yaml': good({ id: 'X1-01n', tester: 'codex', impl: 'claude' }),
    // A new ledger with the old roles (CR3-03).
    'ops/tasks/X1-01o.yaml': good({
      id: 'X1-01o',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    'ops/tasks/X1-01k.yaml': good({
      id: 'X1-01k',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'\n  - 'test/properties/demo/*.test.ts'",
    }),
    'ops/tasks/X1-01l.yaml': good({
      id: 'X1-01l',
      impl: 'claude',
      tester: 'codex',
      test_paths:
        "\n  - 'packages/demo/src/**'\n  - 'test/sp*'\n  - 'specs/commission-examples.csv'",
    }),
    'ops/tasks/X1-01m.yaml': good({
      id: 'X1-01m',
      impl: 'claude',
      tester: 'none',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
  });
  try {
    expect(checkTask('X1-01k', opts('RV1'))).toEqual([]);
    expect(loadTask('X1-01k', root).test_paths).toEqual([
      'test/spec/demo/**',
      'test/properties/demo/*.test.ts',
    ]);
    // An older ledger without the field still parses (test_paths: []).
    expect(loadTask('X1-01', root).test_paths).toEqual([]);
    expect(checkTask('X1-01l', opts('RV1'))).toEqual([
      'test_paths: "packages/demo/src/**" is not inside the rule-test assets (class 1 of tools/guard/protected-paths.json)',
      'test_paths: "test/sp*" is not inside the rule-test assets (class 1 of tools/guard/protected-paths.json)',
    ]);
    expect(checkTask('X1-01m', opts('RV1')).join('\n')).toContain(
      'a task without a rule-test author (tester: none) has no test_paths',
    );
    // CR2-02: a new task that omits test_paths is refused; a switch-baseline ledger is not.
    expect(checkTask('X1-01n', opts('RV1')).join('\n')).toContain(
      'test_paths: required for a task with a rule-test author (tester: codex)',
    );
    expect(checkTask('X1-01', opts('RV1'))).toEqual([]);
    // CR3-03: a new ledger cannot take the old roles; a legacy one keeps them.
    expect(checkTask('X1-01o', opts('RV1'))).toEqual([
      'impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)',
      'tester: must be codex or none for a task written after the switch of 2026-10-05',
    ]);
    expect(checkTask('X1-01e', opts('RV1'))).toEqual([]);
  } finally {
    for (const id of ['X1-01k', 'X1-01l', 'X1-01m', 'X1-01n', 'X1-01o']) {
      removeDir(`${root}/ops/tasks/${id}.yaml`);
    }
  }
});

// A stand-in for the trusted guard: one report per set, counting the calls.
function countingGuard(): {
  manyCalls: string[][][];
  oneCalls: string[][];
  many: (sets: readonly (readonly string[])[]) => RiskReport[];
  one: (paths: readonly string[]) => RiskReport;
} {
  const report = (paths: readonly string[]): RiskReport => ({
    risk: paths.some((p) => p.startsWith('apps/')) ? 'RV1' : 'RV0',
    ask: false,
    paths: paths.map((path) => ({ path, risk: 'RV0', rule: null, protected: null })),
  });
  const g = {
    manyCalls: [] as string[][][],
    oneCalls: [] as string[][],
    many: (sets: readonly (readonly string[])[]) => {
      g.manyCalls.push(sets.map((s) => [...s]));
      return sets.map(report);
    },
    one: (paths: readonly string[]) => {
      g.oneCalls.push([...paths]);
      return report(paths);
    },
  };
  return g;
}

it('batchRisk asks the guard once for all distinct sets and hands back its report per set', () => {
  const g = countingGuard();
  const lookup = batchRisk([['docs/a.md'], ['apps/x/**', 'docs/a.md'], ['docs/a.md']], g);
  expect(lookup(['apps/x/**', 'docs/a.md'])).toEqual(g.one(['apps/x/**', 'docs/a.md']));
  expect(lookup(['docs/a.md']).risk).toBe('RV0');
  expect(g.manyCalls).toEqual([[['docs/a.md'], ['apps/x/**', 'docs/a.md']]]);
  // A set the batch was not asked about goes to the guard on its own.
  g.oneCalls.length = 0;
  expect(lookup(['apps/y/**']).risk).toBe('RV1');
  expect(g.oneCalls).toEqual([['apps/y/**']]);
});

it('batchRisk asks every set on its own when the combined call fails or is not one report per set', () => {
  for (const broken of [
    () => {
      throw new Error('guard failed');
    },
    () => [] as RiskReport[],
  ]) {
    const g = countingGuard();
    const reasons: string[] = [];
    const lookup = batchRisk([['docs/a.md'], ['apps/x/**']], {
      many: broken,
      one: g.one,
      onFallback: (r) => reasons.push(r),
    });
    expect(lookup(['docs/a.md']).risk).toBe('RV0');
    expect(lookup(['apps/x/**']).risk).toBe('RV1');
    expect(g.oneCalls).toEqual([['docs/a.md'], ['apps/x/**']]);
    expect(reasons).toHaveLength(1);
  }
});

it('checkTasks asks the guard once, for the implementation tasks only', () => {
  const own = scratchDir('task-batch');
  writeFiles(own, {
    'ops/tasks/X1-01.yaml': good(),
    'ops/tasks/X1-01a.yaml': good({ id: 'X1-01a', paths: "\n  - 'apps/x/**'" }),
    'ops/tasks/X1-01b.yaml': good({ id: 'X1-01b', type: 'migration', paths: "\n  - 'db/m/**'" }),
    'ops/tasks/X1-01c.yaml': good({ id: 'X1-01c', type: 'contract', paths: "\n  - 'docs/x/**'" }),
  });
  try {
    const g = countingGuard();
    const ids = ['X1-01', 'X1-01a', 'X1-01b', 'X1-01c'];
    const results = checkTasks(ids, { root: own, spec, riskSets: g.many, risk: g.one });
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(g.manyCalls).toEqual([[['packages/demo/src/**'], ['apps/x/**'], ['db/m/**']]]);
    expect(g.oneCalls).toEqual([]);
  } finally {
    removeDir(own);
  }
});

it('shows a task together with its computed risk', () => {
  const view = showTask('X1-01', opts('RV1'));
  expect(view.id).toBe('X1-01');
  expect(view.risk).toBe('RV1');
  expect(view.risk_paths).toEqual([
    { path: 'packages/demo/src/**', risk: 'RV1', rule: null, protected: null },
  ]);
});

// The cases below use the real ledger, the real guard and the planning repository at SPEC_REF.

it(
  'the real ledger passes `task.ts check`',
  () => {
    const res = runCli('task.ts', ['check', '--json']);
    expect(res.stderr).toContain('台账检查通过');
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as { ok: boolean; tasks: { id: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.tasks.map((t) => t.id)).toEqual(listTaskIds());
  },
  CLI_TIMEOUT,
);

it(
  '`task.ts show <id> --json` prints a real task together with its computed risk',
  () => {
    // Whatever the ledger holds today; archived tasks leave it (规划/11 §2.1).
    const id = listTaskIds()[0];
    if (id === undefined) {
      expect(runCli('task.ts', ['show', 'ZZ-99', '--json']).status).toBe(1);
      return;
    }
    const task = loadTask(id);
    const res = runCli('task.ts', ['show', id, '--json']);
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as { risk: string; risk_paths: { path: string }[] };
    expect(doc).toMatchObject({ id, impl: task.impl, tester: task.tester, paths: task.paths });
    expect(doc.risk).toMatch(/^RV[012]$/);
    expect(doc.risk_paths.map((p) => p.path)).toEqual(task.paths);
    // The money package is funds code: never below RV2 (规划/11 §1.1).
    if (task.paths.some((p) => p.startsWith('packages/money/'))) expect(doc.risk).toBe('RV2');
  },
  CLI_TIMEOUT,
);

it(
  'rejects bad usage with exit code 2',
  () => {
    expect(runCli('task.ts', ['show', 'B2-01a']).status).toBe(2);
    expect(runCli('task.ts', ['check', '../etc']).status).toBe(2);
    expect(runCli('task.ts', ['frobnicate']).status).toBe(2);
  },
  CLI_TIMEOUT,
);

it('[ops/approvals.yaml id 23] a listed row and its split tasks may name impl: codex with tester: claude; nothing else changes', () => {
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'tools/guard/codex-impl-tasks.json': JSON.stringify({ approval: 23, tasks: ['X1-02'] }),
    // Listed row X1-02, split task with the Codex-first pair.
    'ops/tasks/X1-02c.yaml': good({
      id: 'X1-02c',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    // Listed row, but the pair is not the Codex-first one.
    'ops/tasks/X1-02d.yaml': good({
      id: 'X1-02d',
      impl: 'codex',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    // Listed row, Codex-first pair, but no test_paths: Claude's rule tests still need them.
    'ops/tasks/X1-02e.yaml': good({ id: 'X1-02e', impl: 'codex', tester: 'claude' }),
    // Listed row keeping the default split is still fine (a withdrawn exception, 规划/11 §2.5).
    'ops/tasks/X1-02f.yaml': good({
      id: 'X1-02f',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    // Row X1-01 is not listed: the Codex-first pair stays refused.
    'ops/tasks/X1-01p.yaml': good({
      id: 'X1-01p',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
  });
  try {
    expect(checkTask('X1-02c', opts('RV2'))).toEqual([]);
    expect(checkTask('X1-02c', opts('RV1'))).toEqual([]);
    expect(checkTask('X1-02d', opts('RV1'))).toEqual([
      'impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)',
    ]);
    expect(checkTask('X1-02e', opts('RV1')).join('\n')).toContain(
      'test_paths: required for a task with a rule-test author (tester: claude)',
    );
    expect(checkTask('X1-02f', opts('RV2'))).toEqual([]);
    expect(checkTask('X1-01p', opts('RV1'))).toEqual([
      'impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)',
      'tester: must be codex or none for a task written after the switch of 2026-10-05',
    ]);
    // A broken list lists nothing (fail-closed).
    writeFiles(root, { 'tools/guard/codex-impl-tasks.json': '{ broken' });
    expect(checkTask('X1-02c', opts('RV1')).join('\n')).toContain('impl: must be claude');
  } finally {
    for (const id of ['X1-02c', 'X1-02d', 'X1-02e', 'X1-02f', 'X1-01p']) {
      removeDir(`${root}/ops/tasks/${id}.yaml`);
    }
    removeDir(`${root}/tools/guard/codex-impl-tasks.json`);
  }
});
