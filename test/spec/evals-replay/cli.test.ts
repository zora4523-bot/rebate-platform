import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { CaseResult, Report, SmokeVerdict } from '../../../packages/evals/src/index.ts';
import { canonicalJson } from '../../../packages/evals/src/index.ts';
import { digest, jsonl, reportFixture } from './fixtures.ts';

// 按任务 §9 的命令行夹具约定使用 tmpdir；本文件仅由编排者在隔离容器运行。
function withCliFixture(run: (paths: { root: string; casesDir: string; manifest: string; report: string }, fixture: ReturnType<typeof reportFixture>) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'couli-B3-01b-'));
  try {
    const casesDir = join(root, 'cases');
    mkdirSync(casesDir);
    const fixture = reportFixture();
    const manifest = join(root, 'manifest.json');
    const report = join(root, 'report.json');
    writeFileSync(join(casesDir, 'a.jsonl'), jsonl(fixture.cases.slice(0, 15)));
    writeFileSync(join(casesDir, 'b.jsonl'), jsonl(fixture.cases.slice(15)));
    writeFileSync(join(casesDir, 'ignored.txt'), '不得把非 jsonl 当题集');
    writeFileSync(manifest, JSON.stringify(fixture.manifest));
    writeFileSync(report, JSON.stringify(fixture.report));
    run({ root, casesDir, manifest, report }, fixture);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function cli(paths: { casesDir: string; manifest: string; report: string }) {
  return spawnSync(process.execPath, [
    fileURLToPath(new URL('../../../packages/evals/src/cli.ts', import.meta.url)),
    'smoke-gate', '--cases', paths.casesDir, '--manifest', paths.manifest, '--report', paths.report,
  ], { encoding: 'utf8', timeout: 10000 });
}

function expectedVerdict(report: Report): SmokeVerdict {
  return {
    passed: report.summary.pass === report.summary.total,
    eval_set: `${report.meta.eval_set.set}@${report.meta.eval_set.version}`,
    content_sha256: report.meta.eval_set.content_sha256, report_sha256: digest(canonicalJson(report)),
    total: report.summary.total, pass: report.summary.pass, fail: report.summary.fail,
    coverage_gap: report.summary.coverage_gap, error: report.summary.error,
  };
}

it('[BR-AI-21] CLI 读全部 jsonl，通过退出 0，stdout 仅一行 verdict JSON', () => {
  withCliFixture((paths, fixture) => {
    const result = cli(paths);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout.trim()).toMatch(/^\{.*\}$/);
    expect(JSON.parse(result.stdout)).toEqual(expectedVerdict(fixture.report));
    for (const c of fixture.cases) {
      expect(result.stdout).not.toContain(c.id);
      for (const turn of c.turns) expect(result.stdout).not.toContain(turn.text);
    }
  });
});

it.each(['coverage_gap', 'error', 'fail'] as const)('[BR-AI-21] CLI 有一题 %s 退出 1，stderr 仅问题 code/id，不泄露 message/题文', (type) => {
  withCliFixture((paths, fixture) => {
    const c = fixture.report.cases[0] as CaseResult;
    c.result = type;
    c.first_failed_layer = type === 'fail' ? 'L3' : null;
    c.problems = [{ code: type === 'fail' ? 'intent_mismatch' : type === 'error' ? 'timeout' : 'recording_miss', layer: c.first_failed_layer, turn: 1, message: '独特敏感消息-CLI-SENSITIVE-MESSAGE' }];
    fixture.report.summary.pass -= 1;
    fixture.report.summary[type] += 1;
    const counts = fixture.report.summary.by_category[c.category];
    if (counts) { counts.pass -= 1; counts[type] += 1; }
    writeFileSync(paths.report, JSON.stringify(fixture.report));
    const result = cli(paths);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout.trim()).toMatch(/^\{.*\}$/);
    expect(JSON.parse(result.stdout)).toEqual(expectedVerdict(fixture.report));
    expect(result.stderr).toContain('smoke_not_passed');
    expect(result.stderr).toContain(c.id);
    expect(result.stdout).not.toContain(c.id);
    expect(result.stdout + result.stderr).not.toContain('CLI-SENSITIVE-MESSAGE');
    for (const item of fixture.cases) {
      for (const turn of item.turns) expect(result.stdout + result.stderr).not.toContain(turn.text);
    }
  });
});

it.each(['json', 'schema'] as const)('[B3-01b] CLI 解析 %s 问题退出 2，只打印 code/file/line', (kind) => {
  withCliFixture((paths) => {
    const marker = 'CLI-SENSITIVE-PARSE-PAYLOAD';
    const malformed = kind === 'json' ? `{"text":"${marker}",broken` : JSON.stringify({ id: 'sensitive-invalid-id', turns: [{ text: marker }] });
    writeFileSync(join(paths.casesDir, 'bad.jsonl'), `\n${malformed}\n`);
    const result = cli(paths);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    const emitted = result.stdout + result.stderr;
    expect(emitted).toContain(kind);
    expect(emitted).toContain('bad.jsonl');
    expect(emitted).toMatch(/\b2\b/);
    expect(emitted).not.toContain(marker);
    expect(emitted).not.toContain('sensitive-invalid-id');
    expect(emitted).not.toContain('report_sha256');
  });
});

it('[B3-01b] CLI 检查不同文件重复 id，按解析问题退出 2', () => {
  withCliFixture((paths, fixture) => {
    writeFileSync(join(paths.casesDir, 'duplicate.jsonl'), jsonl([fixture.cases[0]]));
    const result = cli(paths);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain('duplicate_id');
    expect(result.stdout + result.stderr).not.toContain(fixture.cases[0]?.turns[0]?.text);
  });
});
