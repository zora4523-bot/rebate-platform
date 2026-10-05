import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { listTaskIds, loadTask } from '../lib/task-file.ts';
import {
  agentsFilesFor,
  generateBrief,
  MAX_BRIEF_BYTES,
  ruleTestFiles,
  sectionSizes,
} from './brief.ts';
import type { GenerateOptions } from './brief.ts';
import { findRule } from './spec.ts';
import { bumpAttempt, updateState } from './state.ts';
import {
  CLI_TIMEOUT,
  fixedRisk,
  fixtureGit,
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
  '| BR-DEMO-01 | **演示规则**<br>金额用整数分，见 BR-DEMO-02 | 已确认 | packages/demo 影响面文字 |',
  '| BR-DEMO-02 | **被引用的规则**<br>比例用万分之一 | 默认假设 | 另一处影响面 |',
  '',
  '#### BR-DEMO-01 细则 · 演示规则',
  '',
  '- 状态：已确认',
  '- 例：1 分',
  '',
  '#### BR-DEMO-02 细则 · 被引用的规则',
  '',
  '- 状态：默认假设',
  '- 这段细则不该出现在一跳引用里',
  '',
].join('\n');
const CASES = [
  '| 编号 | 目标 | Given | When | Then |',
  '| --- | --- | --- | --- | --- |',
  '| AC-S1-01 | 演示用例 | 已登录 | 下单 | 见 BR-DEMO-01 |',
  '',
].join('\n');
const spec = memorySpec({
  '规划/08_业务规则/01_DEMO.md': RULES,
  '规划/10_首个完整流程验收用例.md': CASES,
});
const PROTECTED = JSON.stringify({
  class1_add_only: ['test/spec/**', 'packages/testing/**'],
  class2_verify_config: ['**/vitest*.config.*', 'turbo.json'],
  class3_gates: ['tools/**', '**/AGENTS.md'],
});

let base = '';
let root = '';
let specCommit = '';
const clean = (): { ok: boolean; detail: string } => ({ ok: true, detail: '' });
const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({
  root,
  spec,
  risk: fixedRisk('RV2'),
  bannedTerms: clean,
  ...over,
});

beforeAll(() => {
  base = scratchDir('brief');
  root = join(base, 'repo');
  process.env.COULI_RUNS = join(base, 'runs');
  writeFiles(root, {
    'AGENTS.md': '# AGENTS.md（fixture）\n\n根规则第一行。\n',
    'packages/AGENTS.md': '# packages\n\n中间一级的规则。\n',
    'packages/demo/AGENTS.md': '# packages/demo\n\n模块规则：单一写者。\n',
    'packages/demo/src/deep/AGENTS.md': '# deep\n\n更深一级的规则。\n',
    'packages/other/AGENTS.md': '# other\n\n不相关的模块。\n',
    'packages/demo/node_modules/x/AGENTS.md': '# vendored\n',
    'tools/guard/protected-paths.json': PROTECTED,
    'ops/tasks/X1-01.yaml': taskYaml({
      title: '演示任务：金额类型',
      refs: '[BR-DEMO-01, AC-S1-01]',
      accept: "\n  - 'pnpm verify'\n  - 'pnpm --filter demo test'\n  - 'test/spec/demo/**'",
    }),
    'ops/tasks/X1-02.yaml': taskYaml({ id: 'X1-02', paths: "\n  - 'packages/**'" }),
  });
  fixtureGit(root, ['init', '-q', '-b', 'main']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'fixture']);
  fixtureGit(root, ['checkout', '-q', '-b', 'task/X1-01']);
  writeFiles(root, {
    'test/spec/demo/money.spec.test.ts': '// red test\n',
    'packages/demo/src/index.ts': 'export {};\n',
  });
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'test(spec): demo']);
  specCommit = fixtureGit(root, ['rev-parse', 'HEAD']);
});

afterAll(() => removeDir(base));

it('collects the nested AGENTS.md chain shallowest first, plus the ones below the glob, never the root', () => {
  expect(agentsFilesFor(['packages/demo/src/**'], root)).toEqual([
    'packages/AGENTS.md',
    'packages/demo/AGENTS.md',
    'packages/demo/src/deep/AGENTS.md',
  ]);
  expect(agentsFilesFor(['packages/demo/src/index.ts'], root)).toEqual([
    'packages/AGENTS.md',
    'packages/demo/AGENTS.md',
  ]);
  expect(agentsFilesFor(['docs/**', 'packages/other/**'], root)).toEqual([
    'packages/AGENTS.md',
    'packages/other/AGENTS.md',
  ]);
  // A path at the repository root only has the root file, which Codex injects by itself.
  expect(agentsFilesFor(['README.md'], root)).toEqual([]);
});

it(
  'lists the rule-test files that the spec commit added',
  () => {
    expect(ruleTestFiles(specCommit, root, ['test/spec/**', 'packages/testing/**'])).toEqual([
      'test/spec/demo/money.spec.test.ts',
    ]);
  },
  CLI_TIMEOUT,
);

it('writes the eight sections of the template in order', () => {
  const out = generateBrief('X1-01', opts());
  expect(out).toBe(join(base, 'runs', 'X1-01', 'brief.md'));
  const text = readFileSync(out, 'utf8');
  const marks = [
    '# 任务 X1-01：演示任务：金额类型',
    '- 仓库：rebate-platform；分支：`task/X1-01`；第 1 次尝试',
    '- 规格版本：`SPEC_REF=',
    '- 风险级：RV2；实现：codex；规则测试作者：claude',
    '- 本轮阶段：impl（实现：规则测试已冻结，不改不删；测试只经可信容器入口跑）',
    '- 依赖任务：无',
    '## 1. 目标',
    '演示任务：金额类型。关联验收编号：AC-S1-01。',
    '## 2. 规则原文（来自 08，版本同 SPEC_REF）',
    '### BR-DEMO-01（状态：已确认）',
    '| BR-DEMO-01 | **演示规则**<br>金额用整数分，见 BR-DEMO-02 | 已确认 |',
    '#### BR-DEMO-01 细则 · 演示规则',
    '### AC-S1-01',
    '| AC-S1-01 | 演示用例 | 已登录 | 下单 | 见 BR-DEMO-01 |',
    '### 一跳引用',
    '| BR-DEMO-02 | **被引用的规则**<br>比例用万分之一 | 默认假设 |',
    '列名、错误码、枚举值以 `contracts/` 与 `db/schema.sql` 为准',
    '## 3. 可以改的路径',
    '- `packages/demo/src/**`',
    '## 4. 不能改的',
    '- 保护路径（落在你的允许路径之内、仍然不能动的）：`**/vitest*.config.*`、`**/AGENTS.md`',
    '- 保护路径（验收用的规则测试所在，不能改、不能删，也不要为了变绿去动它们）：`test/spec/**`',
    '- 其余保护路径都在允许路径之外，同样不能碰；完整清单见 `tools/guard/protected-paths.json`。',
    '- 已有规则测试：本任务还没有规则测试提交',
    '- `ops/`、`docs/` 下任何文件；结果只写进 JSON 输出。',
    '## 5. 必须遵守的仓库规则',
    '根 AGENTS.md 由 Codex 与 Claude Code 自动读取，这里不再内嵌；',
    '<!-- packages/AGENTS.md 全文开始 -->',
    '中间一级的规则。',
    '模块规则：单一写者。',
    '更深一级的规则。',
    '## 6. 验收命令',
    '```\npnpm verify:fast\npnpm --filter demo test\n```',
    '必须变绿的规则测试：`test/spec/demo/**`。完整验证由编排者在沙箱外跑。',
    '`<couli-runs>/trusted/rebate-platform/tools/ops/verify-container.sh X1-01 --fast`',
    '## 7. 上一轮失败输出（第 2 次起才有）',
    '（第 1 次尝试，没有上一轮。）',
    '## 8. 输出',
    '| `task_done` | 是否认为完成 |',
    '| `notes` | 需要评审方注意的地方，三句以内 |',
    'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 规则测试已冻结，不改不删；它们是 Codex 写的，只在容器里运行，不在宿主上跑。除可信容器入口 `tools/ops/verify-container.sh <编号> --fast` 外，不要运行需要网络、Docker、数据库或监听端口的命令。',
  ];
  const positions = marks.map((m) => text.indexOf(m));
  expect(positions.filter((p) => p < 0)).toEqual([]);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // The 影响面 column, unrelated modules and vendored files stay out.
  expect(text).not.toContain('影响面文字');
  expect(text).not.toContain('这段细则不该出现在一跳引用里');
  expect(text).not.toContain('不相关的模块');
  expect(text).not.toContain('vendored');
  // The root AGENTS.md is auto-injected by Codex (codex-run.sh runs at the repository root).
  expect(text).not.toContain('根规则第一行。');
  expect(text).not.toContain('<!-- AGENTS.md 全文开始 -->');
  // Protected globs that neither reach into `paths` nor hold the accepted rule tests are
  // not repeated: the path guard refuses them anyway.
  expect(text).not.toContain('`turbo.json`');
  expect(text).not.toContain('`packages/testing/**`');
  expect(text.endsWith('监听端口的命令。\n')).toBe(true);
});

it(
  'adds the spec commit, the attempt number and the tail of the previous failure',
  () => {
    const log = join(base, 'verify-log.txt');
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    lines[250] = 'fence ``` inside the log';
    writeFileSync(log, `${lines.join('\n')}\n`);
    bumpAttempt('X1-01', 'impl');
    bumpAttempt('X1-01', 'impl');
    updateState('X1-01', { state: 'doing', spec_commit: specCommit, last_error: log });

    const text = readFileSync(generateBrief('X1-01', opts()), 'utf8');
    expect(text).toContain('第 2 次尝试');
    expect(text).toContain(
      `- 已有规则测试（\`spec_commit=${specCommit}\` 之后不得改动）：\`test/spec/demo/money.spec.test.ts\``,
    );
    const section = text.slice(text.indexOf('## 7.'), text.indexOf('## 8.'));
    expect(section).toContain('\nline 101\n');
    expect(section).not.toContain('\nline 100\n');
    expect(section).toContain('\nline 300\n```');
    expect(section).toContain("fence ''' inside the log");

    // --attempt overrides the state; attempt 1 never carries a failure section.
    const first = readFileSync(generateBrief('X1-01', opts({ attempt: 1 })), 'utf8');
    expect(first).toContain('（第 1 次尝试，没有上一轮。）');
  },
  CLI_TIMEOUT,
);

it('[ops/approvals.yaml id 19] the test phase lets Codex add rule tests and skeletons only; review is read-only', () => {
  // A ledger without test_paths gets no test-phase brief (CR-06).
  expect(() => generateBrief('X1-01', opts({ phase: 'test' }))).toThrow(/没有 test_paths/);
  writeFiles(root, {
    'ops/tasks/X1-05.yaml': taskYaml({
      id: 'X1-05',
      tester: 'codex',
      impl: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      accept: "\n  - 'pnpm verify'\n  - 'test/spec/demo/**'",
    }),
  });
  const test = readFileSync(generateBrief('X1-05', opts({ phase: 'test', attempt: 1 })), 'utf8');
  const marks = [
    '- 本轮阶段：test（写规则 / 验收测试（Codex）',
    '## 3. 可以改的路径',
    '- 本任务的规则测试（台账 `test_paths`；只新增文件，已有的不改不删）：`test/spec/demo/**`',
    '- 任务路径内只放 `NotImplemented` 骨架，逐个函数检查',
    '- `packages/demo/src/**`',
    '- 第一类保护路径（规则测试资产）里已有的文件：不能改、不能删；`test_paths` 以外的规则测试资产不能碰。',
    '```\npnpm typecheck\npnpm lint\n```',
    '本轮要的是「先红」',
    '找不到模块、`TypeError`、语法错误的红不算',
    'Codex 沙箱里只做不执行测试的静态检查',
    '| `tests_passed` | 类型检查与 lint 通过时填 true（测试由编排者在容器里跑，先红由它核对） |',
    '只写规则 / 验收测试与 `NotImplemented` 骨架，不写实现。只做静态检查，不运行测试；不要运行需要网络、Docker、数据库或监听端口的命令。',
  ];
  const positions = marks.map((m) => test.indexOf(m));
  expect(positions.filter((p) => p < 0)).toEqual([]);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // RO-04: Codex writing tests in its sandbox never gets the container entry or Docker.
  // Codex is told the orchestrator runs the red run; it never gets the container entry itself.
  expect(test).not.toContain('verify-container.sh X1-05 --fast');
  expect(test).toContain('编排者用 `tools/ops/verify-container.sh X1-05 --red`');
  // RO2-01/04: the Codex sandbox executes no test; the orchestrator runs them in a container.
  expect(test).not.toContain('```\npnpm verify:fast');
  expect(test).not.toContain('规则测试已冻结');
  expect(test).not.toContain('验收用的规则测试所在，不能改、不能删');

  const handover = readFileSync(generateBrief('X1-01', opts({ phase: 'handover' })), 'utf8');
  expect(handover).toContain('- 本轮阶段：handover（换家实现（Codex，一次）');
  expect(handover).toContain('```\npnpm typecheck\npnpm lint\n```');
  expect(handover).toContain('Codex 沙箱里只做不执行测试的静态检查');
  expect(handover).not.toContain('verify-container.sh');
  expect(
    handover
      .trimEnd()
      .endsWith(
        '规则测试已冻结，不改不删。只做静态检查，不运行测试；不要运行需要网络、Docker、数据库或监听端口的命令。',
      ),
  ).toBe(true);

  const review = readFileSync(generateBrief('X1-01', opts({ phase: 'review' })), 'utf8');
  expect(review).toContain('- 本轮阶段：review（评审对照（只读）');
  expect(review).toContain('第 1 次尝试');
  expect(review.trimEnd().split('\n').at(-1)).toBe(
    '评审只读：不改任何文件，不提交，不安装依赖。不要运行需要网络、Docker、数据库或监听端口的命令。',
  );
});

it(
  'counts the attempt of the phase: Codex writing tests apart from the implementation',
  () => {
    writeFiles(root, {
      'ops/tasks/X1-04.yaml': taskYaml({ id: 'X1-04', test_paths: "\n  - 'test/spec/demo/**'" }),
    });
    bumpAttempt('X1-04', 'test');
    bumpAttempt('X1-04', 'test');
    expect(readFileSync(generateBrief('X1-04', opts({ phase: 'test' })), 'utf8')).toContain(
      '第 2 次尝试',
    );
    // Two test-writing rounds are no implementation attempt; a handover adds to the Opus ones.
    expect(readFileSync(generateBrief('X1-04', opts()), 'utf8')).toContain('第 1 次尝试');
    bumpAttempt('X1-04', 'impl');
    bumpAttempt('X1-04', 'handover');
    expect(readFileSync(generateBrief('X1-04', opts({ phase: 'impl' })), 'utf8')).toContain(
      '第 2 次尝试',
    );
    expect(runCli('brief.ts', ['X1-04', '--phase', 'deploy']).status).toBe(2);
  },
  CLI_TIMEOUT,
);

it('refuses a brief over 24 KB and tells that the task must be split', () => {
  writeFiles(root, { 'packages/huge/AGENTS.md': `# huge\n\n${'规则'.repeat(5000)}\n` });
  const out = join(base, 'runs', 'X1-02', 'brief.md');
  expect(() => generateBrief('X1-02', opts())).toThrow(
    /超过上限 24576 字节（24KB）：任务 X1-02 该拆小[\s\S]*各节字节数：0\. 文件头 \d+；1\. 目标 \d+；[\s\S]*5\. 必须遵守的仓库规则 3\d{4}；[\s\S]*8\. 输出 \d+$/,
  );
  expect(existsSync(out)).toBe(false);
  expect(MAX_BRIEF_BYTES).toBe(24576);
  removeDir(join(root, 'packages', 'huge'));
});

it(
  'shrinks the previous failure output to the room that is left instead of refusing a retry',
  () => {
    // About 19 KB of rules: with the full 8 KB failure tail the brief would pass 24 KB.
    writeFiles(root, {
      'packages/big/AGENTS.md': `# big\n\n${'规则很长。'.repeat(1250)}\n`,
      'ops/tasks/X1-03.yaml': taskYaml({ id: 'X1-03', paths: "\n  - 'packages/big/**'" }),
    });
    const log = join(base, 'big-log.txt');
    const lines = Array.from({ length: 200 }, (_, i) => `失败输出 ${i + 1} ${'x'.repeat(80)}`);
    writeFileSync(log, `${lines.join('\n')}\n`);
    bumpAttempt('X1-03', 'impl');
    bumpAttempt('X1-03', 'impl');
    updateState('X1-03', { state: 'doing', last_error: log });

    const text = readFileSync(generateBrief('X1-03', opts()), 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    // The room is used: no more than one log line is left unused.
    expect(bytes).toBeGreaterThan(MAX_BRIEF_BYTES - 200);
    const section = text.slice(text.indexOf('## 7.'), text.indexOf('## 8.'));
    expect(section).toMatch(/（更早的 \d+ 行已截去）/);
    expect(section).toContain('失败输出 200 ');
    expect(section).not.toContain('失败输出 1 ');

    // With less than 1 KB left for the failure output the task is too big: refuse.
    writeFiles(root, { 'packages/big/AGENTS.md': `# big\n\n${'规则很长。'.repeat(1480)}\n` });
    expect(() => generateBrief('X1-03', opts())).toThrow(/该拆小/);
    removeDir(join(root, 'packages', 'big'));
  },
  CLI_TIMEOUT,
);

it('measures the sections of a brief and ignores headings of embedded files', () => {
  const text = [
    '# 任务 X',
    '',
    '## 1. 目标',
    'a',
    '## 2. 规则原文',
    '## 5. 不是下一节',
    '```',
    '## 3. 围栏里的不算',
    '```',
    '<!-- AGENTS.md 全文开始 -->',
    '## 3. 内嵌文件里的不算',
    '<!-- AGENTS.md 全文结束 -->',
    '## 3. 可以改的路径',
    '',
  ].join('\n');
  const sizes = sectionSizes(text);
  expect(sizes.map((s) => s.title)).toEqual([
    '0. 文件头',
    '1. 目标',
    '2. 规则原文',
    '3. 可以改的路径',
  ]);
  expect(sizes.reduce((sum, s) => sum + s.bytes, 0)).toBe(Buffer.byteLength(text, 'utf8') + 1);
});

it('refuses a brief that hits a banned term and leaves no file behind', () => {
  const out = join(base, 'runs', 'banned.md');
  const seen: string[] = [];
  const hit = (file: string): { ok: boolean; detail: string } => {
    seen.push(readFileSync(file, 'utf8'));
    return { ok: false, detail: 'line 12: Prisma' };
  };
  expect(() => generateBrief('X1-01', opts({ out, bannedTerms: hit }))).toThrow(
    /命中禁用词[\s\S]*Prisma/,
  );
  expect(seen[0]).toContain('# 任务 X1-01');
  expect(existsSync(out)).toBe(false);
  expect(existsSync(`${out}.candidate`)).toBe(false);
});

// The cases below use the real ledger, the real guards and the planning repository at SPEC_REF.

it(
  'generates the brief of a real task within the size limit, with the real rules embedded',
  () => {
    // The first open task of the ledger. Tasks leave the ledger when they are archived
    // (规划/11 §2.1), so nothing here names one.
    const runs = join(base, 'real-runs');
    const id = listTaskIds().find((t) => loadTask(t).status === 'todo') ?? listTaskIds()[0];
    if (id === undefined) {
      expect(runCli('brief.ts', ['ZZ-99'], { COULI_RUNS: runs }).status).toBe(1);
      return;
    }
    const task = loadTask(id);
    const res = runCli('brief.ts', [id], { COULI_RUNS: runs });
    expect(res.stderr).toContain('任务书已生成');
    expect(res.status).toBe(0);
    const out = join(runs, id, 'brief.md');
    expect(res.stdout.trim()).toBe(out);
    const text = readFileSync(out, 'utf8');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    expect(text.startsWith(`# 任务 ${id}：${task.title}\n`)).toBe(true);
    expect(text).toContain(`；实现：${task.impl}；规则测试作者：${task.tester}\n`);
    expect(text).toMatch(/\n- 风险级：RV[012]；/);
    expect(sectionSizes(text).map((s) => s.title.slice(0, 2))).toEqual([
      '0.',
      '1.',
      '2.',
      '3.',
      '4.',
      '5.',
      '6.',
      '7.',
      '8.',
    ]);
    // Every rule is quoted from the planning repository, without the 影响面 column.
    const section2 = text.slice(text.indexOf('\n## 2. '), text.indexOf('\n## 3. '));
    for (const ref of task.refs) {
      const rule = findRule(ref);
      expect(section2).toContain(`### ${ref}`);
      expect(section2).toContain(rule.rowText.trim());
      if (rule.detailText !== '') expect(section2).toContain(rule.detailText);
    }
    expect(section2).not.toContain('| 影响面 |');
    for (const path of task.paths) expect(text).toContain(`\n- \`${path}\`\n`);
    // The root AGENTS.md is not embedded: Codex reads it by itself at the repository root.
    expect(text).toContain(
      '## 5. 必须遵守的仓库规则\n\n根 AGENTS.md 由 Codex 与 Claude Code 自动读取',
    );
    expect(text).not.toContain('<!-- AGENTS.md 全文开始 -->');
    expect(text.endsWith('监听端口的命令。\n')).toBe(true);

    // Expectations below are computed from the ledger entry, so they hold for whichever
    // task is first in the ledger (no task id or ledger content is written here).
    const ruleTests = task.accept.filter((a) => !/^(pnpm|node|npx|bash|sh)\s/.test(a));
    expect(text).toContain(
      `必须变绿的规则测试：${ruleTests.length === 0 ? '无' : ruleTests.map((t) => `\`${t}\``).join('、')}。`,
    );
    // Every AGENTS.md on the static prefix of an allowed path is embedded in full.
    for (const path of task.paths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i);
        if (dir.some((p) => /[*?{[]/.test(p))) break;
        const file = [...dir, 'AGENTS.md'].join('/');
        if (!existsSync(join(repoRoot(), file))) continue;
        const body = readFileSync(join(repoRoot(), file), 'utf8').trim();
        expect(text).toContain(`<!-- ${file} 全文开始 -->\n\n${body}\n\n<!-- ${file} 全文结束 -->`);
      }
    }
  },
  CLI_TIMEOUT,
);

it(
  'rejects bad usage with exit code 2 and an unknown task with exit code 1',
  () => {
    const env = { COULI_RUNS: join(base, 'real-runs') };
    expect(runCli('brief.ts', [], env).status).toBe(2);
    expect(runCli('brief.ts', ['X1-01', '--attempt', '0'], env).status).toBe(2);
    expect(runCli('brief.ts', ['ZZ-99'], env).status).toBe(1);
  },
  CLI_TIMEOUT,
);

it('a contract task quotes only the named 04 sections and lists BR refs by id and title', () => {
  const contracts = [
    '# 04 数据模型与契约',
    '',
    '## 1. 术语表',
    '',
    '不该出现的术语表。',
    '',
    '## 2. 枚举',
    '',
    '### 2.1 平台',
    '',
    '平台枚举正文。',
    '',
    '```text',
    '## 3. 代码块里的标题不算',
    '```',
    '',
    '## 3. 核心数据模型',
    '',
    '### 3.1 关系图',
    '',
    '关系图正文。',
    '',
    '### 3.2 主要表字段',
    '',
    '不该出现的表字段。',
    '',
  ].join('\n');
  const contractSpec = memorySpec({
    '规划/08_业务规则/01_DEMO.md': RULES,
    '规划/10_首个完整流程验收用例.md': CASES,
    '规划/04_数据模型与契约.md': contracts,
  });
  writeFiles(root, {
    'ops/tasks/X1-03.yaml': taskYaml({
      id: 'X1-03',
      type: 'contract',
      title: '演示契约',
      contract_sections: "['2', '3.1']",
      paths: "\n  - 'contracts/**'",
    }),
  });
  const text = readFileSync(generateBrief('X1-03', opts({ spec: contractSpec })), 'utf8');
  const marks = [
    '## 2. 契约依据（04 相关节原文；BR 只列编号与标题，版本同 SPEC_REF）',
    '- BR-DEMO-01：演示规则',
    '<!-- 04 §2 全文开始 -->',
    '## 2. 枚举',
    '平台枚举正文。',
    '## 3. 代码块里的标题不算',
    '<!-- 04 §2 全文结束 -->',
    '<!-- 04 §3.1 全文开始 -->',
    '### 3.1 关系图',
    '关系图正文。',
    '<!-- 04 §3.1 全文结束 -->',
    '## 3. 可以改的路径',
  ];
  const positions = marks.map((m) => text.indexOf(m));
  expect(positions.filter((p) => p < 0)).toEqual([]);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // No BR text, no detail, no one-hop references, no other 04 sections.
  expect(text).not.toContain('金额用整数分');
  expect(text).not.toContain('一跳引用');
  expect(text).not.toContain('不该出现');
  expect(sectionSizes(text).map((s) => s.title)).toEqual([
    '0. 文件头',
    '1. 目标',
    '2. 契约依据（04 相关节原文；BR 只列编号与标题，版本同 SPEC_REF）',
    '3. 可以改的路径',
    '4. 不能改的',
    '5. 必须遵守的仓库规则',
    '6. 验收命令',
    '7. 上一轮失败输出（第 2 次起才有）',
    '8. 输出',
  ]);
  writeFiles(root, {
    'ops/tasks/X1-03.yaml': taskYaml({
      id: 'X1-03',
      type: 'contract',
      contract_sections: "['9']",
      paths: "\n  - 'contracts/**'",
    }),
  });
  expect(() => generateBrief('X1-03', opts({ spec: contractSpec }))).toThrow(/04 §9: not found/);
});
