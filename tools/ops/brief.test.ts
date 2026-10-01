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

it('collects the AGENTS.md chain root first, plus the ones below the glob', () => {
  expect(agentsFilesFor(['packages/demo/src/**'], root)).toEqual([
    'AGENTS.md',
    'packages/AGENTS.md',
    'packages/demo/AGENTS.md',
    'packages/demo/src/deep/AGENTS.md',
  ]);
  expect(agentsFilesFor(['packages/demo/src/index.ts'], root)).toEqual([
    'AGENTS.md',
    'packages/AGENTS.md',
    'packages/demo/AGENTS.md',
  ]);
  expect(agentsFilesFor(['docs/**', 'packages/other/**'], root)).toEqual([
    'AGENTS.md',
    'packages/AGENTS.md',
    'packages/other/AGENTS.md',
  ]);
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
    '根规则第一行。',
    '中间一级的规则。',
    '模块规则：单一写者。',
    '更深一级的规则。',
    '## 6. 验收命令',
    '```\npnpm verify:fast\npnpm --filter demo test\n```',
    '必须变绿的规则测试：`test/spec/demo/**`。完整验证由编排者在沙箱外跑。',
    '## 7. 上一轮失败输出（第 2 次起才有）',
    '（第 1 次尝试，没有上一轮。）',
    '## 8. 输出',
    '| `task_done` | 是否认为完成 |',
    '| `notes` | 需要评审方注意的地方，三句以内 |',
    'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 不要运行需要网络、Docker、数据库或监听端口的命令。',
  ];
  const positions = marks.map((m) => text.indexOf(m));
  expect(positions.filter((p) => p < 0)).toEqual([]);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // The 影响面 column, unrelated modules and vendored files stay out.
  expect(text).not.toContain('影响面文字');
  expect(text).not.toContain('这段细则不该出现在一跳引用里');
  expect(text).not.toContain('不相关的模块');
  expect(text).not.toContain('vendored');
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
    // The first open task of the ledger, B2-01a while the trial loop is being set up. Tasks
    // leave the ledger when they are archived (规划/11 §2.1), so nothing here names one.
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
    // The root AGENTS.md is embedded in full, first.
    const rootAgents = readFileSync(join(repoRoot(), 'AGENTS.md'), 'utf8').trim();
    expect(text).toContain(
      `## 5. 必须遵守的仓库规则\n\n<!-- AGENTS.md 全文开始 -->\n\n${rootAgents}\n\n<!-- AGENTS.md 全文结束 -->`,
    );
    expect(text.endsWith('监听端口的命令。\n')).toBe(true);

    if (id === 'B2-01a') {
      expect(text).toContain('| BR-CALC-01 | **金额与比例的数据类型**<br>');
      expect(text).toContain('#### BR-CALC-08 细则 · 舍入与尾差归属');
      // One-hop reference, row only.
      expect(text).toContain('| BR-CALC-02 | **分佣基数 B 的定义**<br>');
      expect(text).not.toContain('#### BR-CALC-02 细则');
      expect(text).toContain('`**/package.json#scripts`');
      expect(text).toContain('<!-- packages/money/AGENTS.md 全文开始 -->');
      expect(text).toContain('必须变绿的规则测试：`test/properties/money/**`。');
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
