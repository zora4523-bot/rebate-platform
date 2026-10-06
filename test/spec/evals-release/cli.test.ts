import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { main } from '../../../packages/evals/src/cli.ts';
import type { Metric } from '../../../packages/evals/src/index.ts';
import {
  count,
  expectedVerdict,
  expectNoPrivateText,
  fullFixture,
  fullMetrics,
  mark,
  metric,
} from './fixtures.ts';

// 只由编排者在隔离容器运行；临时文件在仓库 .tmp，不用宿主临时目录。
function withFiles(
  run: (
    paths: Record<'root' | 'cases' | 'manifest' | 'report' | 'facts' | 'b', string>,
    f: ReturnType<typeof fullFixture>,
  ) => void,
): void {
  const parent = resolve('.tmp/evals-release-cli');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  const paths = {
    root,
    cases: join(root, 'cases'),
    manifest: join(root, 'manifest.json'),
    report: join(root, 'report.json'),
    facts: join(root, 'facts.json'),
    b: join(root, 'b.json'),
  };
  try {
    mkdirSync(paths.cases);
    const f = fullFixture();
    writeFileSync(
      join(paths.cases, 'a.jsonl'),
      f.cases
        .slice(0, 150)
        .map((c) => JSON.stringify(c))
        .join('\n'),
    );
    writeFileSync(
      join(paths.cases, 'b.jsonl'),
      f.cases
        .slice(150)
        .map((c) => JSON.stringify(c))
        .join('\n'),
    );
    writeFileSync(paths.manifest, JSON.stringify(f.manifest));
    writeFileSync(paths.report, JSON.stringify(f.report));
    writeFileSync(paths.facts, JSON.stringify(f.facts));
    writeFileSync(paths.b, JSON.stringify(f.report));
    run(paths, f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function invoke(args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = main(args, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
function releaseArgs(p: Record<'cases' | 'manifest' | 'report' | 'facts', string>) {
  return [
    'release-gate',
    '--cases',
    p.cases,
    '--manifest',
    p.manifest,
    '--report',
    p.report,
    '--facts',
    p.facts,
  ];
}

it('[BR-AI-21] [AC-B3-01c-CLI01] release-gate 通过退出 0，stdout 一行完整 verdict，stderr 空', () => {
  withFiles((p, f) => {
    const got = invoke(releaseArgs(p));
    expect(got.code).toBe(0);
    expect(got.stderr).toBe('');
    expect(got.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(got.stdout)).toEqual(expectedVerdict(f.report));
    expect(expectNoPrivateText(got.stdout, f.cases)).toBe(true);
  });
});

it.each(['failure', 'unverified'] as const)(
  '[BR-AI-21] [AC-B3-01c-CLI02] release-gate %s 退出 1，stderr 只有 code 与指标 id',
  (kind) => {
    withFiles((p, f) => {
      let expected: Metric[];
      if (kind === 'failure') {
        mark(f.report, 0, 'fail', 'amount_in_text');
        expected = fullMetrics().map((m) =>
          m.id === 'leak_amount'
            ? metric(m.id, 1, 300, 'fail')
            : m.id === 't1_recognition'
              ? metric(m.id, 49, 50)
              : m,
        );
      } else {
        f.facts[0]!.card_values = count(0, 0, 1);
        expected = fullMetrics().map((m) =>
          m.id === 'card_values' ? metric(m.id, 49, 50, 'not_covered') : m,
        );
      }
      writeFileSync(p.report, JSON.stringify(f.report));
      writeFileSync(p.facts, JSON.stringify(f.facts));
      const got = invoke(releaseArgs(p));
      expect(got.code).toBe(1);
      expect(got.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(got.stdout)).toEqual(expectedVerdict(f.report, expected, false));
      expect(got.stderr.trim().split(/\s+/)).toEqual(
        kind === 'failure'
          ? ['metric_failed', 'leak_amount']
          : ['metric_not_covered', 'card_values'],
      );
      expect(expectNoPrivateText(got.stdout + got.stderr, f.cases)).toBe(true);
      expect(got.stderr).not.toContain(p.root);
    });
  },
);

it.each(
  (['manifest', 'report', 'facts'] as const).flatMap((file) =>
    (['io', 'json'] as const).map((kind) => ({ file, kind })),
  ),
)(
  '[B3-01c] [AC-B3-01c-CLI03] release-gate $file 的 $kind 退出 2，只打印 code 与文件名',
  ({ file, kind }) => {
    withFiles((p) => {
      if (kind === 'io') rmSync(p[file]);
      else writeFileSync(p[file], '{"secret":"CLI-PRIVATE-TEXT",broken');
      const got = invoke(releaseArgs(p));
      expect(got.code).toBe(2);
      expect(got.stdout).toBe('');
      expect(got.stderr.trim().split(/\s+/)).toEqual([kind, `${file}.json`]);
      expect(got.stderr).not.toContain('CLI-PRIVATE-TEXT');
      expect(got.stderr).not.toContain(p.root);
    });
  },
);

it('[B3-01c] [AC-B3-01c-CLI04] release-gate 题集 JSONL 无法解析时不输出 verdict', () => {
  withFiles((p) => {
    writeFileSync(join(p.cases, 'bad.jsonl'), '{"text":"CLI-PRIVATE-TEXT",broken');
    const got = invoke(releaseArgs(p));
    expect(got.code).toBe(2);
    expect(got.stdout).toBe('');
    expect(got.stderr.trim().split(/\s+/)).toEqual(['json', 'bad.jsonl']);
    expect(got.stderr).not.toContain('CLI-PRIVATE-TEXT');
  });
});

it('[B3-01c] [AC-B3-01c-CLI05] compare 正常退出 0，stdout 一行对照报告且不含题文', () => {
  withFiles((p, f) => {
    const got = invoke(['compare', '--a', p.report, '--b', p.b, '--min-sample', '1']);
    expect(got.code).toBe(0);
    expect(got.stderr).toBe('');
    expect(got.stdout.trim().split('\n')).toHaveLength(1);
    const header = {
      vendor: f.report.meta.vendor,
      model_snapshot: f.report.meta.model_snapshot,
      mode: 'B',
    };
    expect(JSON.parse(got.stdout)).toEqual({
      problems: [],
      header: { a: header, b: header },
      rows: [
        ['all', 300],
        ['T1', 50],
        ['T2', 40],
        ['T3', 40],
        ['T4', 40],
        ['T5', 20],
        ['T6', 20],
        ['injection', 20],
        ['unauthorized', 20],
        ['banned', 20],
        ['chitchat', 30],
      ].map(([scope, n]) => ({
        scope,
        a: { n, pass: n },
        b: { n, pass: n },
        delta_pp: 0,
        status: 'compared',
      })),
    });
    expect(expectNoPrivateText(got.stdout, f.cases)).toBe(true);
  });
});

it('[B3-01c] [AC-B3-01c-CLI06] compare 不同题集退出 1、rows 为空', () => {
  withFiles((p, f) => {
    const b = structuredClone(f.report);
    b.meta.eval_set.content_sha256 = 'e'.repeat(64);
    writeFileSync(p.b, JSON.stringify(b));
    const got = invoke(['compare', '--a', p.report, '--b', p.b]);
    expect(got.code).toBe(1);
    expect(got.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(got.stdout)).toMatchObject({
      problems: [expect.objectContaining({ code: 'eval_set_mismatch' })],
      rows: [],
    });
    expect(expectNoPrivateText(got.stdout + got.stderr, f.cases)).toBe(true);
  });
});

it.each(['io', 'json'] as const)('[B3-01c] [AC-B3-01c-CLI07] compare %s 退出 2', (kind) => {
  withFiles((p) => {
    if (kind === 'io') rmSync(p.b);
    else writeFileSync(p.b, '{"secret":"CLI-PRIVATE-TEXT",broken');
    const got = invoke(['compare', '--a', p.report, '--b', p.b]);
    expect(got.code).toBe(2);
    expect(got.stdout).toBe('');
    expect(got.stderr.trim().split(/\s+/)).toEqual([kind, 'b.json']);
    expect(got.stderr).not.toContain(p.root);
    expect(got.stderr).not.toContain('CLI-PRIVATE-TEXT');
  });
});
