import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect } from 'vitest';
import { artifactTextViews } from '../../../../infra/release-scan/detect/association.ts';
import { readArtifact, scanArtifact } from '../../../../infra/release-scan/detect/index.ts';
import type { ScanResult } from '../../../../infra/release-scan/detect/index.ts';
import { realManifest, writeZip } from '../detect/fixtures.ts';
import type { ZipFile } from '../detect/fixtures.ts';

// QA-09d 任务书 §9 特别要求：制品只在测试运行时于系统临时目录生成，并清理。
// 本文件不注册测试；宿主只做静态检查，以下代码仅由编排者在容器里执行。
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const SHORT = ['demo', 'v1'].join('-');
export const SECOND = ['demo', 'v2'].join('-');
export const LOW = 'a1'.repeat(10);
export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/** 同时验收新字段视图和原公开入口，避免只实现一个未接入扫描器的解析器。 */
export async function inspect(ext: 'apk' | 'aab' | 'hap' | 'app', files: readonly ZipFile[]) {
  const dir = mkdtempSync(join(tmpdir(), 'QA-09d-'));
  dirs.push(dir);
  const path = writeZip(dir, `fixture.${ext}`, files);
  const read = await readArtifact(path);
  expect(read.errors).toEqual([]);
  const associated = artifactTextViews(read.entries);
  const scan = await scanArtifact({
    path,
    platform: ext === 'hap' || ext === 'app' ? 'harmony' : 'android',
    manifestYaml: realManifest(),
    approvals: [],
  });
  return { associated, scan };
}

export type Inspected = Awaited<ReturnType<typeof inspect>>;

export function expectPair(result: Inspected, path: string, key: string, value: string): void {
  expect(result.associated.errors).toEqual([]);
  const lines = result.associated.views
    .filter((view) => view.path === path)
    .flatMap((view) => view.text.split('\n'));
  expect(lines).toContain(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
}

export function expectSecret(result: Inspected, file: string, value: string): void {
  expect(result.associated.errors).toEqual([]);
  expect(result.scan.errors).toEqual([]);
  expect(result.scan.exit_code).toBe(1);
  expect(result.scan.passed).toBe(false);
  expect(result.scan.hits).toContainEqual({
    rule: 'request-sign-material',
    file,
    match: value,
    never_accepted: true,
    line: expect.any(Number),
  });
  const decisions = result.scan.report.decisions.filter(
    (d) => d.hit.rule === 'request-sign-material' && d.hit.match === value && d.hit.file === file,
  );
  expect(decisions.length).toBeGreaterThan(0);
  for (const d of decisions) {
    expect([d.verdict, d.reason]).toEqual(['block', 'never_accepted']);
    expect(Number.isInteger(d.hit.line) && d.hit.line > 0).toBe(true);
  }
}

export function expectClean(result: Inspected): void {
  expect(result.associated.errors).toEqual([]);
  expect(result.scan.errors).toEqual([]);
  expect(result.scan.hits).toEqual([]);
  expect(result.scan.exit_code).toBe(0);
  expect(result.scan.passed).toBe(true);
}

export function expectUnreadable(result: Inspected, path: string): void {
  expect(result.associated.errors.some((error) => error.includes(path))).toBe(true);
  expect(result.scan.errors.some((error) => error.includes(path))).toBe(true);
  expect(result.scan.exit_code).toBe(2);
  expect(result.scan.passed).toBe(false);
}

export function materialValues(scan: ScanResult, file: string): string[] {
  return [
    ...new Set(
      scan.hits
        .filter((hit) => hit.rule === 'request-sign-material' && hit.file === file)
        .map((hit) => hit.match),
    ),
  ].sort();
}
