// agents-pair, risk-map-coverage, agents-table, protected-sync, hidden-unicode, spec-ref, tree.
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAgentsPairs } from './agents-pair.ts';
import {
  TABLE_BEGIN,
  TABLE_END,
  extractTable,
  renderRiskTable,
  replaceTable,
} from './agents-table.ts';
import { cleanupFixtures, fixtureGit, makeRepo, makeTree, writeFiles } from './fixture-kit.ts';
import { findHiddenUnicode, scanFilesForHiddenUnicode } from './hidden-unicode.ts';
import {
  EMBED_BEGIN,
  EMBED_END,
  SCRIPT_BEGIN,
  SCRIPT_END,
  compareEmbedded,
  compareEmbeddedScript,
  extractEmbedded,
} from './protected-sync.ts';
import { checkCoverage } from './risk-map-coverage.ts';
import { parseRiskMap } from './risk.ts';
import { checkSpecRef } from './spec-ref.ts';
import { listTreeFiles } from './tree.ts';

afterAll(cleanupFixtures);

const RISK_MAP = [
  'version: 1',
  'rules:',
  "  - path: 'docs/**'",
  '    risk: RV0',
  '    impl: claude',
  '    tester: none',
  '    review: codex',
  "  - path: 'apps/api/src/modules/health/**'",
  '    risk: RV1',
  '    impl: codex',
  '    tester: claude',
  '    review: claude',
  "  - path: 'packages/money/**'",
  '    risk: RV2',
  '    impl: codex',
  '    tester: claude',
  '    review: claude+codex',
  '',
].join('\n');

describe('listTreeFiles', () => {
  it('walks a plain directory and skips build and dependency folders', () => {
    const root = makeTree({
      'a.ts': '',
      'src/深/b c.ts': '',
      'node_modules/x/index.js': '',
      'dist/a.js': '',
      '.tmp/scratch.txt': '',
      '.turbo/log': '',
      '.hidden/kept.txt': '',
    });
    expect(listTreeFiles(root)).toEqual({
      files: ['.hidden/kept.txt', 'a.ts', 'src/深/b c.ts'],
      mode: 'walk',
    });
  });

  it('uses git when the tree is a repository: tracked plus untracked, minus ignored and deleted', () => {
    const { root } = makeRepo({
      '.gitignore': 'ignored/\n',
      'tracked.ts': '',
      '中文 目录/tracked 2.ts': '',
      'gone.ts': '',
    });
    writeFiles(root, { 'untracked.ts': '', 'ignored/x.ts': '' });
    fixtureGit(root, ['rm', '-q', '--cached', 'gone.ts']);
    fixtureGit(root, ['clean', '-q', '-f', 'gone.ts']);
    symlinkSync(join(root, 'tracked.ts'), join(root, 'link.ts'));
    expect(listTreeFiles(root)).toEqual({
      files: ['.gitignore', 'tracked.ts', 'untracked.ts', '中文 目录/tracked 2.ts'],
      mode: 'git',
    });
  });
});

describe('checkAgentsPairs', () => {
  const lines = (n: number): string =>
    `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;

  it('accepts paired files within the caps', () => {
    const root = makeTree({
      'AGENTS.md': lines(150),
      'CLAUDE.md': '@AGENTS.md\n',
      'apps/api/AGENTS.md': lines(60),
      'apps/api/CLAUDE.md': '@AGENTS.md',
    });
    expect(checkAgentsPairs(root, listTreeFiles(root).files)).toEqual([]);
  });

  it('reports missing siblings, wrong CLAUDE.md content and oversized files', () => {
    const root = makeTree({
      'AGENTS.md': lines(151),
      'CLAUDE.md': '@AGENTS.md\n\nextra rule\n',
      'apps/api/AGENTS.md': lines(61),
      'packages/money/CLAUDE.md': '@AGENTS.md\n',
    });
    expect(checkAgentsPairs(root, listTreeFiles(root).files)).toEqual([
      'CLAUDE.md: must contain exactly one line "@AGENTS.md"',
      'AGENTS.md: 151 lines, the cap is 150',
      'apps/api/AGENTS.md: no sibling CLAUDE.md',
      'apps/api/AGENTS.md: 61 lines, the cap is 60',
      'packages/money/CLAUDE.md: no sibling AGENTS.md',
    ]);
  });

  it('requires the root rules file', () => {
    const root = makeTree({ 'README.md': 'x\n' });
    expect(checkAgentsPairs(root, listTreeFiles(root).files)).toEqual([
      'AGENTS.md: the root rules file is missing',
    ]);
  });
});

describe('checkCoverage', () => {
  it('requires an explicit rule for every module and package directory', () => {
    const root = makeTree({
      'apps/api/src/modules/health/index.ts': '',
      'apps/api/src/modules/ledger/index.ts': '',
      'apps/api/src/modules/README.md': '',
      'packages/money/src/index.ts': '',
      'packages/domain/src/index.ts': '',
    });
    mkdirSync(join(root, 'packages', 'node_modules'));
    expect(checkCoverage(root, parseRiskMap(RISK_MAP))).toEqual({
      problems: [
        'apps/api/src/modules/ledger: no explicit rule in ops/risk-map.yaml',
        'packages/domain: no explicit rule in ops/risk-map.yaml',
      ],
      notices: [],
    });
  });

  it('does not accept a wide rule in place of naming the directory', () => {
    const root = makeTree({ 'packages/money/a.ts': '', 'packages/other/a.ts': '' });
    const wide = parseRiskMap(
      `${RISK_MAP}  - path: 'packages/**'\n    risk: RV2\n    impl: codex\n    tester: claude\n    review: claude+codex\n`,
    );
    const { problems, notices } = checkCoverage(root, wide);
    expect(problems).toEqual(['packages/other: no explicit rule in ops/risk-map.yaml']);
    expect(notices).toEqual(['apps/api/src/modules: directory does not exist yet']);
  });
});

describe('agents table', () => {
  const table = renderRiskTable(parseRiskMap(RISK_MAP));

  it('renders one row per rule plus the default row', () => {
    expect(table.split('\n')).toEqual([
      '| 路径 | 主实现 | 规则测试作者 | 对抗评审 | 风险级 |',
      '| --- | --- | --- | --- | --- |',
      '| `docs/**` | Claude | — | Codex | RV0 |',
      '| `apps/api/src/modules/health/**` | Codex | Claude | Claude | RV1 |',
      '| `packages/money/**` | Codex | Claude | Claude + Codex | RV2 |',
      '| 其他（未列入的任何路径） | 见任务台账 | 见任务台账 | Claude + Codex | RV2 |',
    ]);
  });

  // The table is separated from the marker comments by blank lines so that Markdown renderers
  // treat it as a table and not as a continuation of the HTML comment block.
  it('replaces the block between the markers and is idempotent', () => {
    const doc = `# AGENTS\n\n## 3. 分工\n\n${TABLE_BEGIN}\nold table\n${TABLE_END}\n\n- 规则\n`;
    const updated = replaceTable(doc, table);
    expect(updated).toBe(
      `# AGENTS\n\n## 3. 分工\n\n${TABLE_BEGIN}\n\n${table}\n\n${TABLE_END}\n\n- 规则\n`,
    );
    expect(extractTable(updated)).toBe(table);
    expect(replaceTable(updated, table)).toBe(updated);
    expect(extractTable(`${TABLE_BEGIN}\n${TABLE_END}\n`)).toBe('');
  });

  it('insists on exactly one pair of markers in order', () => {
    expect(() => extractTable('no markers')).toThrow(/markers/);
    expect(() => extractTable(`${TABLE_END}\n${TABLE_BEGIN}\n`)).toThrow(/exactly once/);
    expect(() => replaceTable(`${TABLE_BEGIN}\n${TABLE_BEGIN}\n${TABLE_END}\n`, table)).toThrow(
      /exactly once/,
    );
  });
});

describe('protected-sync', () => {
  const source = { class1_add_only: ['test/spec/**'], class3_gates: ['tools/**', '.github/**'] };
  const workflow = (body: string[]): string =>
    [
      'jobs:',
      '  protected-paths:',
      '    steps:',
      '      - run: |',
      `          ${EMBED_BEGIN}`,
      ...body.map((l) => `          ${l}`),
      `          ${EMBED_END}`,
      '          echo done',
      '',
    ].join('\n');

  it('accepts an identical copy regardless of formatting and key order', () => {
    const body = [
      '{',
      '  "class3_gates": ["tools/**", ".github/**"],',
      '  "class1_add_only": ["test/spec/**"]',
      '}',
    ];
    expect(extractEmbedded(workflow(body))).toEqual(source);
    expect(compareEmbedded(source, workflow(body))).toEqual([]);
    expect(compareEmbedded(source, workflow(body.map((l) => `# ${l}`)))).toEqual([]);
  });

  it('reports drift, broken JSON and missing markers', () => {
    const drifted = [
      '{ "class1_add_only": ["test/spec/**"], "class3_gates": [".github/**", "tools/**"] }',
    ];
    expect(compareEmbedded(source, workflow(drifted))).toEqual([
      'the embedded copy differs from tools/guard/protected-paths.json',
    ]);
    expect(compareEmbedded(source, workflow(['{ nope']))[0]).toMatch(/not valid JSON/);
    expect(compareEmbedded(source, 'jobs: {}\n')[0]).toMatch(/must appear exactly once/);
    expect(compareEmbedded(source, workflow([]))[0]).toMatch(/nothing between the markers/);
  });
});

describe('protected-sync: the embedded owner-approval script', () => {
  const source = "export function f(a) {\n  return a + '!';\n}\n\nexport const g = 1;\n";
  const workflow = (body: string[], indent = '          '): string =>
    [
      'jobs:',
      '  protected-paths:',
      '    steps:',
      '      - run: |',
      "          node --input-type=module <<'NODE'",
      `          ${SCRIPT_BEGIN}`,
      ...body.map((l) => (l === '' ? '' : `${indent}${l}`)),
      `          ${SCRIPT_END}`,
      '          NODE',
      '',
    ].join('\n');
  const verbatim = source.trimEnd().split('\n');

  it('accepts a verbatim copy inside the YAML block scalar', () => {
    expect(compareEmbeddedScript(source, workflow(verbatim))).toEqual([]);
  });

  it('reports drift, missing markers and a line outside the block', () => {
    const drifted = verbatim.map((l) => l.replace("'!'", "'?'"));
    expect(compareEmbeddedScript(source, workflow(drifted))).toEqual([
      'the embedded copy differs from tools/guard/lib/owner-approval.mjs',
    ]);
    expect(compareEmbeddedScript(source, 'jobs: {}\n')[0]).toMatch(/must appear exactly once/);
    const shallow = workflow(verbatim).replace('          return', '  return');
    expect(compareEmbeddedScript(source, shallow)[0]).toMatch(/indented less than/);
  });
});

describe('hidden unicode', () => {
  it('finds bidirectional controls and zero-width characters with their position', () => {
    const text = `const a = 1;\nconst b = "x\u202Ey"; // \u200B\n\u2066ok\u2069\n`;
    expect(findHiddenUnicode(text).map((h) => `${h.line}:${h.column}:${h.name}`)).toEqual([
      '2:13:RIGHT-TO-LEFT OVERRIDE',
      '2:21:ZERO WIDTH SPACE',
      '3:1:LEFT-TO-RIGHT ISOLATE',
      '3:4:POP DIRECTIONAL ISOLATE',
    ]);
  });

  it('flags a byte-order mark, joiners and tag characters but not ordinary text', () => {
    expect(findHiddenUnicode('\uFEFFx')).toHaveLength(1);
    expect(findHiddenUnicode('a\u200Cb\u200Dc\u{E0041}')).toHaveLength(3);
    expect(findHiddenUnicode('中文、emoji 🙂 and é — fine\ttab\n')).toEqual([]);
  });

  it('scans text files of a tree and skips binary ones', () => {
    const root = makeTree({
      'ok.ts': 'export const x = 1;\n',
      'bad 文件.md': `# title\n\nhidden\u200Bspace\n`,
      'image.bin': `\u0000\u0001\u200B`,
    });
    const { problems, scanned } = scanFilesForHiddenUnicode(root, listTreeFiles(root).files);
    expect(problems).toEqual(['bad 文件.md:3:7: U+200B ZERO WIDTH SPACE']);
    expect(scanned).toBe(2);
  });
});

describe('checkSpecRef', () => {
  function specRepoWithMain(): { root: string; onMain: string; offMain: string } {
    const { root, base } = makeRepo({ '规划/a.md': 'x\n' });
    fixtureGit(root, ['update-ref', 'refs/remotes/origin/main', base]);
    writeFiles(root, { '规划/a.md': 'y\n' });
    fixtureGit(root, ['commit', '-q', '-am', 'local only']);
    return { root, onMain: base, offMain: fixtureGit(root, ['rev-parse', 'HEAD']) };
  }

  it('passes for a commit on origin/main of the planning repository', () => {
    const spec = specRepoWithMain();
    const root = makeTree({ SPEC_REF: `${spec.onMain}\n` });
    expect(checkSpecRef(root, spec.root, { requireSpecRepo: true })).toMatchObject({
      status: 'pass',
      problems: [],
    });
  });

  it('fails for a commit that is not on origin/main, and for an unknown commit', () => {
    const spec = specRepoWithMain();
    const offMain = makeTree({ SPEC_REF: `${spec.offMain}\n` });
    expect(checkSpecRef(offMain, spec.root, { requireSpecRepo: true }).problems[0]).toMatch(
      /is not an ancestor of origin\/main/,
    );
    const unknown = makeTree({ SPEC_REF: `${'0123456789'.repeat(4)}\n` });
    expect(checkSpecRef(unknown, spec.root, { requireSpecRepo: true }).problems[0]).toMatch(
      /cannot verify/,
    );
  });

  it('checks the format before anything else', () => {
    const spec = '/nonexistent/spec';
    expect(checkSpecRef(makeTree(), spec, { requireSpecRepo: false }).problems).toEqual([
      'SPEC_REF is missing',
    ]);
    expect(
      checkSpecRef(makeTree({ SPEC_REF: 'main\n' }), spec, { requireSpecRepo: false }).problems[0],
    ).toMatch(/40-character/);
    expect(
      checkSpecRef(makeTree({ SPEC_REF: `${'a'.repeat(40)}\nsecond line\n` }), spec, {
        requireSpecRepo: false,
      }).problems[0],
    ).toMatch(/40-character|exactly one line/);
  });

  it('skips the ancestry check without a planning repository unless it is required', () => {
    const root = makeTree({ SPEC_REF: `${'a'.repeat(40)}\n` });
    expect(checkSpecRef(root, '/nonexistent/spec', { requireSpecRepo: false }).status).toBe('skip');
    expect(checkSpecRef(root, '/nonexistent/spec', { requireSpecRepo: true }).status).toBe('fail');
  });
});
