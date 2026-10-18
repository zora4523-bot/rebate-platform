// Ledger overwrite guard (CT-06q): the pure comparison over task-file texts.
import { describe, expect, it } from 'vitest';
import type { Change } from '../../lib/git.ts';
import { parseTaskFile } from '../../lib/task-file.ts';
import { compareLedger, ledgerOverwriteProblems, LEDGER_FILE } from './ledger-overwrite.ts';

/** The done test-change task of #717 that chore(ops) #778 overwrote. */
const DONE = [
  'id: F1-09i',
  'repo: rebate-platform',
  'title: F1-09d 规则测试 [AC-F1-09d#10] 去掉「暂未接入的人群条件不下发」部分',
  'type: test-change',
  '# 2026-10-18 入账（content-client）。',
  'refs: []',
  'refs_hash: {}',
  'deps: [F1-09d]',
  'paths:',
  "  - 'test/spec/content/pages-read/delivery.int.test.ts'",
  'impl: claude',
  'tester: none',
  'accept:',
  "  - 'pnpm verify'",
  'status: done',
  'pr: 717',
  '',
].join('\n');

const OVERWRITTEN = [
  'id: F1-09i',
  'repo: rebate-platform',
  'title: 后台「首页配置」页：页面列表、页面详情、版本列表与详情、存草稿、发布、回滚、预览 token 与草稿二维码',
  'type: impl',
  '# 2026-10-18 入账（前端线 f1-frontend-7）。',
  'refs: []',
  'refs_hash: {}',
  'deps: [F1-09f, F1-09g]',
  'paths:',
  "  - 'apps/admin/src/pages/home-config/**'",
  'test_paths:',
  "  - 'test/spec/frontend/admin-home-config/**'",
  'impl: claude',
  'tester: codex',
  'accept:',
  "  - 'pnpm verify'",
  "  - 'test/spec/frontend/admin-home-config/**'",
  'status: todo',
  '',
].join('\n');

const TODO = DONE.replace('status: done\npr: 717\n', 'status: todo\n');

function replace(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture has no "${from}"`);
  return text.replace(from, to);
}

const PATH = 'ops/tasks/F1-09i.yaml';
const parse = (text: string) => parseTaskFile(text, PATH);
const modified = (): Change[] => [{ path: PATH, status: 'M' }];
const sides = (before: string | null, after: string | null) => ({
  before: () => before,
  after: () => after,
});

describe('LEDGER_FILE', () => {
  it('matches task files directly under ops/tasks only', () => {
    expect(LEDGER_FILE.exec('ops/tasks/F1-09i.yaml')?.[1]).toBe('F1-09i');
    expect(LEDGER_FILE.test('ops/tasks/CT-06q.yml')).toBe(true);
    expect(LEDGER_FILE.test('ops/tasks/archive/F1-09i.yaml')).toBe(false);
    expect(LEDGER_FILE.test('ops/evidence/F1-09i.json')).toBe(false);
    expect(LEDGER_FILE.test('ops/tasks/README.md')).toBe(false);
  });
});

describe('compareLedger', () => {
  it('the overwrite of #778: a done task turned into another task is refused by its id', () => {
    const problems = compareLedger(PATH, parse(DONE), parse(OVERWRITTEN));
    expect(problems).toHaveLength(1);
    const [problem] = problems;
    expect(problem).toContain(`${PATH}: F1-09i 已存在且为 done，新任务请换编号`);
    expect(problem).toContain('title 「');
    expect(problem).toContain('type 「test-change」→「impl」');
    expect(problem).toContain('status done → todo');
  });

  it('the same text, or comment lines only, is no problem', () => {
    expect(compareLedger(PATH, parse(DONE), parse(DONE))).toEqual([]);
    const commented = replace(
      DONE,
      '# 2026-10-18 入账（content-client）。',
      '# 2026-10-19 补注：另见 #778。',
    );
    expect(compareLedger(PATH, parse(DONE), parse(commented))).toEqual([]);
  });

  it('status forward, pr, paths, deps, refs and test_paths may change', () => {
    const done = replace(TODO, 'status: todo\n', 'status: done\npr: 717\n');
    expect(compareLedger(PATH, parse(TODO), parse(done))).toEqual([]);
    const widened = replace(
      replace(TODO, 'deps: [F1-09d]', 'deps: [F1-09d, F1-09g]'),
      "  - 'test/spec/content/pages-read/delivery.int.test.ts'",
      "  - 'test/spec/content/pages-read/delivery.int.test.ts'\n  - 'test/spec/content/pages-read/audience.int.test.ts'",
    )
      .replace('refs: []', 'refs: [BR-CT-01]')
      .replace('refs_hash: {}', 'refs_hash:\n  BR-CT-01: abc');
    expect(compareLedger(PATH, parse(TODO), parse(widened))).toEqual([]);
    // A done task may still gain fields (paths listed late, a pr number filled in).
    const filled = replace(DONE, 'pr: 717', 'pr: 718');
    expect(compareLedger(PATH, parse(DONE), parse(filled))).toEqual([]);
  });

  it('a done task may not go back to todo, even with everything else unchanged', () => {
    const reverted = replace(DONE, 'status: done\n', 'status: todo\n');
    expect(compareLedger(PATH, parse(DONE), parse(reverted))).toEqual([
      `${PATH}: F1-09i 已存在且为 done，新任务请换编号（status done → todo）`,
    ]);
  });

  it('a todo task keeps its title and type too (a change of scope is a new id)', () => {
    const retitled = replace(TODO, '去掉「暂未接入的人群条件不下发」部分', '改为别的事');
    const [problem, ...rest] = compareLedger(PATH, parse(TODO), parse(retitled));
    expect(rest).toEqual([]);
    expect(problem).toContain(`${PATH}: F1-09i 已存在（status todo），不得改 id / type / title`);
    expect(problem).toContain('title 「');
    const retyped = replace(TODO, 'type: test-change', 'type: impl');
    expect(compareLedger(PATH, parse(TODO), parse(retyped))).toEqual([
      `${PATH}: F1-09i 已存在（status todo），不得改 id / type / title；改范围请换编号，补充字段请保留这三项（type 「test-change」→「impl」）`,
    ]);
  });

  it('a long title is clipped in the message, the verdict is the same', () => {
    const long = replace(TODO, '去掉「暂未接入的人群条件不下发」部分', 'x'.repeat(200));
    const [problem] = compareLedger(PATH, parse(TODO), parse(long));
    expect(problem).toContain('…');
    expect(problem?.length ?? 0).toBeLessThan(400);
  });
});

describe('ledgerOverwriteProblems', () => {
  it('reads both sides of a modified task file and ignores other paths', () => {
    expect(ledgerOverwriteProblems(modified(), sides(DONE, OVERWRITTEN))).toHaveLength(1);
    expect(ledgerOverwriteProblems(modified(), sides(DONE, DONE))).toEqual([]);
    const other: Change[] = [
      { path: 'ops/evidence/F1-09i.json', status: 'M' },
      { path: 'ops/tasks/archive/F1-09i.yaml', status: 'D' },
      { path: 'docs/notes.md', status: 'M' },
    ];
    expect(ledgerOverwriteProblems(other, sides(DONE, OVERWRITTEN))).toEqual([]);
  });

  it('an added task file is not compared; a file absent at the fork point is not either', () => {
    expect(
      ledgerOverwriteProblems([{ path: PATH, status: 'A' }], sides(null, OVERWRITTEN)),
    ).toEqual([]);
    expect(
      ledgerOverwriteProblems([{ path: PATH, status: '?' }], sides(null, OVERWRITTEN)),
    ).toEqual([]);
    expect(ledgerOverwriteProblems(modified(), sides(null, OVERWRITTEN))).toEqual([]);
  });

  it('a deleted or renamed task file is refused', () => {
    expect(ledgerOverwriteProblems([{ path: PATH, status: 'D' }], sides(DONE, null))).toEqual([
      `${PATH}: F1-09i 已存在，台账文件不得删除；作废请保留文件、改 status 或加注释`,
    ]);
    // Modified in the index, gone from the working tree: the same.
    expect(ledgerOverwriteProblems(modified(), sides(DONE, null))).toEqual([
      `${PATH}: F1-09i 已存在，台账文件不得删除；作废请保留文件、改 status 或加注释`,
    ]);
    const renamed: Change[] = [{ path: 'ops/tasks/F1-09l.yaml', status: 'R', oldPath: PATH }];
    expect(ledgerOverwriteProblems(renamed, sides(DONE, OVERWRITTEN))).toEqual([
      `${PATH}: F1-09i 已存在，台账文件不得改名或移动（改成了 ops/tasks/F1-09l.yaml）；新任务请换编号新增文件`,
    ]);
    // A rename into ops/tasks from elsewhere adds a task: nothing to compare.
    const movedIn: Change[] = [{ path: PATH, status: 'R', oldPath: 'ops/drafts/F1-09i.yaml' }];
    expect(ledgerOverwriteProblems(movedIn, sides(null, OVERWRITTEN))).toEqual([]);
  });

  it('a side that cannot be parsed fails closed', () => {
    const [bad] = ledgerOverwriteProblems(modified(), sides(DONE, 'id: [\n'));
    expect(bad).toContain(`${PATH}: 改后的台账无法解析`);
    // An id changed inside the file: the file name no longer matches, so the parse refuses it.
    const [renamedId] = ledgerOverwriteProblems(
      modified(),
      sides(DONE, replace(DONE, 'id: F1-09i', 'id: F1-09l')),
    );
    expect(renamedId).toContain(`${PATH}: 改后的台账无法解析`);
    const [baseBad] = ledgerOverwriteProblems(modified(), sides('nope', DONE));
    expect(baseBad).toContain(`${PATH}: 基线上的台账无法解析，不能比对`);
  });
});
