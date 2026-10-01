import { describe, expect, it } from 'vitest';
import { YamlLiteError, parseYamlLite } from './yaml-lite.ts';

function lineOf(text: string): number {
  try {
    parseYamlLite(text);
  } catch (err) {
    if (err instanceof YamlLiteError) return err.line;
    throw err;
  }
  return -1;
}

describe('parseYamlLite: supported constructs', () => {
  it('returns null for empty and comment-only documents', () => {
    expect(parseYamlLite('')).toBeNull();
    expect(parseYamlLite('\n  \n# only a comment\n')).toBeNull();
  });

  it('parses block mappings with every scalar kind', () => {
    const doc = parseYamlLite(
      [
        'plain: hello world',
        "single: 'it''s'",
        'double: "a\\tb\\n\\u4e2d \\"q\\""',
        'int: 42',
        'negative: -7',
        'zero: 0',
        'yes: true',
        'no: false',
        'nothing: null',
        'tilde: ~',
        'empty:',
        'url: https://example.invalid/a?b=c#frag',
        'chinese: ledger：凭证与分录写入',
        'version: 1.2.3',
        'date: 2026-10-01',
      ].join('\n'),
    );
    expect(doc).toEqual({
      plain: 'hello world',
      single: "it's",
      double: 'a\tb\n中 "q"',
      int: 42,
      negative: -7,
      zero: 0,
      yes: true,
      no: false,
      nothing: null,
      tilde: null,
      empty: null,
      url: 'https://example.invalid/a?b=c#frag',
      chinese: 'ledger：凭证与分录写入',
      version: '1.2.3',
      date: '2026-10-01',
    });
  });

  it('strips comments but keeps "#" inside scalars', () => {
    expect(
      parseYamlLite('# header\na: 1 # trailing\nb: "x # y" # c\nc: x#y\nd: [1, 2] # list\n'),
    ).toEqual({ a: 1, b: 'x # y', c: 'x#y', d: [1, 2] });
  });

  it('parses nested mappings and quoted keys', () => {
    expect(parseYamlLite('a:\n  b:\n    c: 1\n  "d e": 2\n\'f\': 3\n')).toEqual({
      a: { b: { c: 1 }, 'd e': 2 },
      f: 3,
    });
  });

  it('parses block sequences of scalars and of mappings', () => {
    expect(parseYamlLite('- a\n- "b c"\n- 3\n- true\n-\n- ~\n')).toEqual([
      'a',
      'b c',
      3,
      true,
      null,
      null,
    ]);
    expect(
      parseYamlLite(
        'rules:\n  - path: "docs/**"\n    risk: RV0\n  - path: x\n    nested:\n      k: v\n    list:\n      - 1\n',
      ),
    ).toEqual({
      rules: [
        { path: 'docs/**', risk: 'RV0' },
        { path: 'x', nested: { k: 'v' }, list: [1] },
      ],
    });
  });

  it('parses flow sequences of scalars and empty flow collections', () => {
    expect(
      parseYamlLite('a: [x, "y, z", 1, true, null, \'q\']\nb: []\nc: {}\nd: [ ]\ne: [B2-01]\n'),
    ).toEqual({ a: ['x', 'y, z', 1, true, null, 'q'], b: [], c: {}, d: [], e: ['B2-01'] });
  });

  it('parses literal block scalars with clip and strip chomping', () => {
    const doc = parseYamlLite(
      [
        'keep: |',
        '  line 1',
        '    indented # not a comment',
        '',
        '  line 3',
        '',
        'strip: |-',
        '  only',
        'after: 1',
        'list:',
        '  - |',
        '    in list',
        '  - name: step',
        '    run: |',
        '      echo "a: b"',
        '      exit 0',
      ].join('\n'),
    );
    expect(doc).toEqual({
      keep: 'line 1\n  indented # not a comment\n\nline 3\n',
      strip: 'only',
      after: 1,
      list: ['in list\n', { name: 'step', run: 'echo "a: b"\nexit 0\n' }],
    });
  });

  it('accepts CRLF line endings, a BOM and one leading document marker', () => {
    expect(parseYamlLite('\uFEFF---\r\na: 1\r\nb:\r\n  - x\r\n')).toEqual({ a: 1, b: ['x'] });
  });

  it('parses the task-ledger example of the planning template', () => {
    const example = [
      'id: B2-02a',
      'repo: rebate-platform',
      'title: ledger：凭证与分录写入、余额缓存、账户行锁',
      'type: impl',
      'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]',
      'refs_hash:',
      '  BR-FUND-13: <12 位哈希>',
      '  BR-FUND-16: <12 位哈希>',
      '  BR-FUND-19: <12 位哈希>',
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
    expect(parseYamlLite(example)).toEqual({
      id: 'B2-02a',
      repo: 'rebate-platform',
      title: 'ledger：凭证与分录写入、余额缓存、账户行锁',
      type: 'impl',
      refs: ['BR-FUND-13', 'BR-FUND-16', 'BR-FUND-19'],
      refs_hash: {
        'BR-FUND-13': '<12 位哈希>',
        'BR-FUND-16': '<12 位哈希>',
        'BR-FUND-19': '<12 位哈希>',
      },
      deps: ['B2-01'],
      paths: ['apps/api/src/modules/ledger/**'],
      impl: 'codex',
      tester: 'claude',
      accept: ['pnpm verify', 'test/spec/ledger/**'],
      status: 'todo',
      pr: null,
    });
  });

  it('parses the approvals format (conventions C10)', () => {
    const text = [
      '# Machine-readable copy of 规划/11 §7.3.',
      'source: "规划/11_开发协作与自主推进.md §7.3"',
      'spec_ref: cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b',
      'approvals:',
      '  - id: 0',
      '    row: 0',
      '    title: "技术栈按 ADR-0001 锁定"',
      '    granted: true',
      '    date: "2026-10-01"',
      '    note: ""',
      '  - id: 9',
      '    row: 9',
      "    title: 'Codex 全局配置'",
      '    granted: true',
      '    date: "2026-10-01"',
      '    note: "选 A，不动 Codex 全局配置"',
    ].join('\n');
    expect(parseYamlLite(text)).toEqual({
      source: '规划/11_开发协作与自主推进.md §7.3',
      spec_ref: 'cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b',
      approvals: [
        {
          id: 0,
          row: 0,
          title: '技术栈按 ADR-0001 锁定',
          granted: true,
          date: '2026-10-01',
          note: '',
        },
        {
          id: 9,
          row: 9,
          title: 'Codex 全局配置',
          granted: true,
          date: '2026-10-01',
          note: '选 A，不动 Codex 全局配置',
        },
      ],
    });
  });

  it('parses a GitHub-workflow-like document with literal blocks', () => {
    const text = [
      'name: protected-paths',
      'on:',
      '  pull_request_target:',
      '    types: [opened, synchronize, reopened]',
      'permissions:',
      '  contents: read',
      '  pull-requests: read',
      'jobs:',
      '  protected-paths:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 5',
      '    steps:',
      '      - name: List changed files',
      '        env:',
      '          GH_TOKEN: ${{ github.token }}',
      '          PR: ${{ github.event.pull_request.number }}',
      '        run: |',
      '          # BEGIN protected-paths.json',
      "          cat > rules.json <<'JSON'",
      '          { "class3_gates": ["tools/**"] }',
      '          JSON',
      '          # END protected-paths.json',
      '          gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --paginate',
      '      - name: Summary',
      '        if: always()',
      '        run: echo done',
      '',
    ].join('\n');
    const doc = parseYamlLite(text) as {
      on: { pull_request_target: { types: string[] } };
      jobs: Record<string, { 'timeout-minutes': number; steps: Record<string, unknown>[] }>;
    };
    expect(doc.on.pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened']);
    const job = doc.jobs['protected-paths'];
    expect(job?.['timeout-minutes']).toBe(5);
    expect(job?.steps).toHaveLength(2);
    expect(job?.steps[0]?.['env']).toEqual({
      GH_TOKEN: '${{ github.token }}',
      PR: '${{ github.event.pull_request.number }}',
    });
    expect(job?.steps[0]?.['run']).toBe(
      [
        '# BEGIN protected-paths.json',
        "cat > rules.json <<'JSON'",
        '{ "class3_gates": ["tools/**"] }',
        'JSON',
        '# END protected-paths.json',
        'gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --paginate',
        '',
      ].join('\n'),
    );
    expect(job?.steps[1]).toEqual({ name: 'Summary', if: 'always()', run: 'echo done' });
  });
});

describe('parseYamlLite: rejected constructs report the line', () => {
  const cases: [name: string, text: string, line: number][] = [
    ['anchor', 'a: 1\nb: &x 2\n', 2],
    ['alias', 'a: 1\nb: *x\n', 2],
    ['anchor on a key', '&k a: 1\n', 1],
    ['tag', 'a: !!str 1\n', 1],
    ['merge key', 'a:\n  <<: 1\n', 2],
    ['second document', 'a: 1\n---\nb: 2\n', 2],
    ['document end marker', 'a: 1\n...\n', 2],
    ['directive', '%YAML 1.2\na: 1\n', 1],
    ['flow mapping with content', 'a: 1\nb: {c: 1}\n', 2],
    ['nested flow sequence', 'a: [1, [2]]\n', 1],
    ['flow mapping inside a flow sequence', 'a: [b: 1]\n', 1],
    ['unterminated flow sequence', 'a: [1,\n  2]\n', 1],
    ['trailing comma in a flow sequence', 'a: [1, ]\n', 1],
    ['empty entry in a flow sequence', 'a: [1,, 2]\n', 1],
    ['tab indentation', 'a:\n\tb: 1\n', 2],
    ['tab separator', 'a:\t1\n', 1],
    ['odd indentation', 'a:\n   b: 1\n', 2],
    ['four-space indentation', 'a:\n    b: 1\n', 2],
    ['over-indented sibling', 'a: 1\n  b: 2\n', 2],
    ['indented top level', '  a: 1\n', 1],
    ['unindented sequence under a key', 'a:\n- 1\n', 2],
    ['sequence of sequences', '- - 1\n', 1],
    ['flow sequence as a sequence entry', '- [1]\n', 1],
    ['two spaces after the dash', '-  a\n', 1],
    ['entry content on the following line', '-\n  a: 1\n', 2],
    ['mixing sequence and mapping', '- a\nb: 1\n', 2],
    ['duplicate key', 'a: 1\nb: 2\na: 3\n', 3],
    ['__proto__ key', '__proto__: 1\n', 1],
    ['complex key', '? a\n: 1\n', 1],
    ['plain multi-line scalar', 'a: one\n  two\n', 2],
    ['plain scalar with a colon-space', 'a: b: c\n', 1],
    ['bare scalar document', 'just text\n', 1],
    ['folded block scalar', 'a: >\n  x\n', 1],
    ['keep chomping indicator', 'a: |+\n  x\n', 1],
    ['indentation indicator', 'a: |2\n  x\n', 1],
    ['over-indented block scalar', 'a: |\n    x\n', 2],
    ['under-indented block scalar', 'a:\n  b: |\n   x\n', 3],
    ['unterminated double quote', 'a: "x\n', 1],
    ['unterminated single quote', "a: 'x\n", 1],
    ['unknown escape', 'a: "\\q"\n', 1],
    ['text after a quoted scalar', 'a: "x" y\n', 1],
    ['float', 'a: 1.5\n', 1],
    ['exponent', 'a: 1e3\n', 1],
    ['leading zero', 'a: 007\n', 1],
    ['hex integer', 'a: 0x1F\n', 1],
    ['integer outside the safe range', 'a: 9007199254740993\n', 1],
    ['capitalised boolean', 'a: True\n', 1],
    ['capitalised null', 'a: NULL\n', 1],
    ['backtick scalar', 'a: `x`\n', 1],
    ['at-sign scalar', 'a: @x\n', 1],
  ];

  it.each(cases)('%s', (_name, text, line) => {
    expect(() => parseYamlLite(text)).toThrow(YamlLiteError);
    expect(lineOf(text)).toBe(line);
  });

  it('puts the line number into the message', () => {
    expect(() => parseYamlLite('a: 1\nb: &x 2\n')).toThrow(/line 2: anchors are not supported/);
  });
});
