import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTaskIds, loadTask, parseTaskFile } from './task-file.ts';

const EXAMPLE = [
  'id: B2-02a',
  'repo: rebate-platform',
  'title: ledger：凭证与分录写入、余额缓存、账户行锁',
  'type: impl',
  'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]',
  'refs_hash:',
  '  BR-FUND-13: 0123456789ab',
  '  BR-FUND-16: 123456789abc',
  '  BR-FUND-19: 23456789abcd',
  'deps: [B2-01]',
  'paths:',
  '  - "apps/api/src/modules/ledger/**"',
  'impl: codex',
  'tester: claude',
  'accept:',
  '  - "pnpm verify"',
  '  - "test/spec/ledger/**"',
  'status: todo',
  'pr: null',
  '',
].join('\n');

function messageOf(text: string, fileName: string): string {
  try {
    parseTaskFile(text, fileName);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('parseTaskFile', () => {
  it('parses the example of the planning template', () => {
    expect(parseTaskFile(EXAMPLE, 'ops/tasks/B2-02a.yaml')).toEqual({
      id: 'B2-02a',
      repo: 'rebate-platform',
      title: 'ledger：凭证与分录写入、余额缓存、账户行锁',
      type: 'impl',
      refs: ['BR-FUND-13', 'BR-FUND-16', 'BR-FUND-19'],
      refs_hash: {
        'BR-FUND-13': '0123456789ab',
        'BR-FUND-16': '123456789abc',
        'BR-FUND-19': '23456789abcd',
      },
      contract_sections: [],
      deps: ['B2-01'],
      paths: ['apps/api/src/modules/ledger/**'],
      impl: 'codex',
      test_paths: [],
      mechanical_paths: [],
      red_exempt: [],
      tester: 'claude',
      accept: ['pnpm verify', 'test/spec/ledger/**'],
      status: 'todo',
      pr: null,
    });
  });

  it('defaults a missing pr to null and accepts a PR number', () => {
    const withoutPr = EXAMPLE.replace('pr: null\n', '');
    expect(parseTaskFile(withoutPr, 'B2-02a.yaml').pr).toBeNull();
    const done = EXAMPLE.replace('status: todo', 'status: done').replace('pr: null', 'pr: 37');
    expect(parseTaskFile(done, 'B2-02a.yaml')).toMatchObject({ status: 'done', pr: 37 });
  });

  it('accepts empty refs, deps and refs_hash', () => {
    const text = EXAMPLE.replace('refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]', 'refs: []')
      .replace(/refs_hash:\n(?: {2}BR-.*\n){3}/, 'refs_hash: {}\n')
      .replace('deps: [B2-01]', 'deps: []');
    expect(parseTaskFile(text, 'B2-02a.yaml')).toMatchObject({ refs: [], refs_hash: {}, deps: [] });
  });

  it('contract_sections: only on contract tasks, as 规划/04 section numbers', () => {
    const contract = EXAMPLE.replace('type: impl', 'type: contract');
    const withSections = contract.replace(
      'deps: [B2-01]',
      "contract_sections: ['2', '6.1']\ndeps: [B2-01]",
    );
    expect(parseTaskFile(withSections, 'B2-02a.yaml').contract_sections).toEqual(['2', '6.1']);
    expect(messageOf(withSections.replace("'6.1'", "'§6.1'"), 'B2-02a.yaml')).toContain(
      'contract_sections: "§6.1" is not a 规划/04 section number',
    );
    expect(
      messageOf(withSections.replace('type: contract', 'type: impl'), 'B2-02a.yaml'),
    ).toContain('contract_sections: only a contract task names 规划/04 sections');
  });

  it('[CT-06r] red_exempt: a list of file / test / reason mappings, the reason at least 10 characters', () => {
    const declared = (entries: string): string =>
      EXAMPLE.replace('tester: claude', `tester: claude\nred_exempt:${entries}`);
    const two = declared(
      "\n  - file: test/spec/ledger-rules/ledger-rules.test.ts\n    test: '[AC-B2-01i#1] CSV 固定十一列'\n    reason: 数据驱动、结构断言对旧 csv 亦成立、不可能有效红\n  - file: test/spec/ledger-rules/ledger-rules.test.ts\n    test: 'rules > [AC-B2-01i#4] 借贷成对'\n    reason: 'structural: holds for the old data too'",
    );
    expect(parseTaskFile(two, 'B2-02a.yaml').red_exempt).toEqual([
      {
        file: 'test/spec/ledger-rules/ledger-rules.test.ts',
        test: '[AC-B2-01i#1] CSV 固定十一列',
        reason: '数据驱动、结构断言对旧 csv 亦成立、不可能有效红',
      },
      {
        file: 'test/spec/ledger-rules/ledger-rules.test.ts',
        test: 'rules > [AC-B2-01i#4] 借贷成对',
        reason: 'structural: holds for the old data too',
      },
    ]);
    // An older ledger without the field: [].
    expect(parseTaskFile(EXAMPLE, 'B2-02a.yaml').red_exempt).toEqual([]);
    // Without a reason, with a short one, with blanks only: refused (the reason is the point).
    const noReason = declared("\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'");
    expect(messageOf(noReason, 'B2-02a.yaml')).toContain(
      'red_exempt[0].reason: must say why the test cannot be shown red (at least 10 characters)',
    );
    const short = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: too short",
    );
    expect(messageOf(short, 'B2-02a.yaml')).toContain('red_exempt[0].reason');
    const blank = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: '              '",
    );
    expect(messageOf(blank, 'B2-02a.yaml')).toContain('red_exempt[0].reason');
    // Missing or empty file / test, a file that is not a repository path, an unknown field.
    const noTest = declared(
      '\n  - file: test/spec/a.test.ts\n    reason: a reason of enough length',
    );
    expect(messageOf(noTest, 'B2-02a.yaml')).toContain(
      "red_exempt[0].test: must be the test's full name",
    );
    const badFile = declared(
      "\n  - file: /test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length",
    );
    expect(messageOf(badFile, 'B2-02a.yaml')).toContain(
      'red_exempt[0].file: "/test/spec/a.test.ts" must be relative',
    );
    const extra = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length\n    note: x",
    );
    expect(messageOf(extra, 'B2-02a.yaml')).toContain('red_exempt[0].note: unknown field');
    // CT-06t: at most 20 declarations (the section is not counted in the file's line limit).
    const many = (n: number): string =>
      declared(
        Array.from(
          { length: n },
          (_, i) =>
            `\n  - file: test/spec/a.test.ts\n    test: '[AC-${i + 1}] a'\n    reason: a reason of enough length`,
        ).join(''),
      );
    expect(parseTaskFile(many(20), 'B2-02a.yaml').red_exempt).toHaveLength(20);
    expect(messageOf(many(21), 'B2-02a.yaml')).toContain('red_exempt: 21 entries, the limit is 20');
    // Not a list, not mappings, the same test twice.
    expect(messageOf(declared(' abc'), 'B2-02a.yaml')).toContain(
      'red_exempt: must be a list of mappings',
    );
    expect(messageOf(declared('\n  - abc'), 'B2-02a.yaml')).toContain(
      'red_exempt[0]: must be a mapping',
    );
    const twice = declared(
      "\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: a reason of enough length\n  - file: test/spec/a.test.ts\n    test: '[AC-1] a'\n    reason: another reason of enough length",
    );
    expect(messageOf(twice, 'B2-02a.yaml')).toContain(
      'red_exempt[1]: "test/spec/a.test.ts > [AC-1] a" is declared twice',
    );
  });

  it('lists every problem in one error', () => {
    const text = [
      'id: b2',
      'repo: web',
      'title: ""',
      'type: feature',
      'refs: BR-FUND-13',
      'refs_hash: [x]',
      'deps: [nope]',
      'paths: []',
      'impl: gpt',
      'tester: nobody',
      'accept: []',
      'status: doing',
      'pr: -1',
      'risk: RV0',
    ].join('\n');
    const message = messageOf(text, 'b2.yaml');
    for (const field of [
      'risk: unknown field',
      'id: must look like',
      'repo: must be one of',
      'title: must be a single non-empty line',
      'type: must be one of',
      'refs: must be a list of strings',
      'refs_hash: must be a mapping',
      'deps: "nope" is not a task id',
      'paths: must not be empty',
      'impl: must be one of',
      'tester: must be one of',
      'accept: must not be empty',
      'status: must be one of',
      'pr: must be a positive integer or null',
    ]) {
      expect(message).toContain(field);
    }
  });

  it('reports missing fields', () => {
    const message = messageOf('id: B2-02a\n', 'B2-02a.yaml');
    for (const field of ['repo', 'title', 'type', 'refs', 'refs_hash', 'deps', 'paths', 'impl']) {
      expect(message).toContain(`${field}: missing`);
    }
    expect(message).not.toContain('pr: missing');
  });

  it('requires the id to match the file name', () => {
    expect(messageOf(EXAMPLE, 'ops/tasks/B2-02.yaml')).toContain(
      'id: "B2-02a" does not match the file name "B2-02.yaml"',
    );
  });

  it('rejects absolute, escaping and directory paths', () => {
    const text = EXAMPLE.replace(
      '  - "apps/api/src/modules/ledger/**"',
      '  - "/etc/passwd"\n  - "../couli/**"\n  - "apps/api/"\n  - "a\\\\b"',
    );
    const message = messageOf(text, 'B2-02a.yaml');
    expect(message).toContain('"/etc/passwd" must be relative');
    expect(message).toContain('"../couli/**" must not contain');
    expect(message).toContain('"apps/api/" must name files');
    expect(message).toContain('"a\\b" must use "/" separators');
  });

  it('rejects paths that hold control characters (a newline or NUL would split a guard call)', () => {
    for (const escape of ['\\n', '\\0', '\\r']) {
      const text = EXAMPLE.replace(
        '  - "apps/api/src/modules/ledger/**"',
        `  - "docs/a${escape}docs/b.md"`,
      );
      expect(messageOf(text, 'B2-02a.yaml')).toContain('must not contain control characters');
    }
  });

  it('wraps YAML errors with the file name and rejects non-mapping documents', () => {
    expect(messageOf('id: &a B2-02a\n', 'B2-02a.yaml')).toMatch(/^B2-02a\.yaml: yaml-lite: line 1/);
    expect(messageOf('- a\n', 'B2-02a.yaml')).toContain('the document must be a mapping');
  });
});

describe('loadTask and listTaskIds', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'couli-tasks-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty list when ops/tasks does not exist', () => {
    expect(listTaskIds(root)).toEqual([]);
  });

  it('lists ids in order and skips the archive tree and other files', () => {
    const dir = join(root, 'ops', 'tasks');
    mkdirSync(join(dir, 'archive', '202610'), { recursive: true });
    writeFileSync(join(dir, 'B2-02a.yaml'), EXAMPLE);
    writeFileSync(join(dir, 'B1-01.yaml'), EXAMPLE.replace('id: B2-02a', 'id: B1-01'));
    writeFileSync(join(dir, 'README.md'), 'not a task\n');
    writeFileSync(join(dir, 'archive', '202610', 'A0-01.yaml'), 'id: A0-01\n');
    expect(listTaskIds(root)).toEqual(['B1-01', 'B2-02a']);
  });

  it('loads a task by id from the given root', () => {
    const dir = join(root, 'ops', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'B2-02a.yaml'), EXAMPLE);
    expect(loadTask('B2-02a', root).paths).toEqual(['apps/api/src/modules/ledger/**']);
  });

  it('refuses ids that are not task ids and reports missing files', () => {
    expect(() => loadTask('../../etc/passwd', root)).toThrow(/invalid task id/);
    expect(() => loadTask('B9-99', root)).toThrow(/task file not found/);
  });
});

describe('tester: claude-independent (ops/approvals.yaml id 36)', () => {
  it('accepts a fresh independent Claude context as the rule-test author, nothing else new', () => {
    const text = EXAMPLE.replace('impl: codex', 'impl: claude').replace(
      'tester: claude',
      'tester: claude-independent',
    );
    expect(parseTaskFile(text, 'B2-02a.yaml').tester).toBe('claude-independent');
    expect(messageOf(EXAMPLE.replace('tester: claude', 'tester: claude-agent'), 'B2-02a.yaml')).toContain(
      'tester: must be one of codex / claude / claude-independent / none',
    );
    // The implementer stays codex or claude: an independent Claude context never implements.
    expect(
      messageOf(EXAMPLE.replace('impl: codex', 'impl: claude-independent'), 'B2-02a.yaml'),
    ).toContain('impl: must be one of codex / claude');
  });
});
