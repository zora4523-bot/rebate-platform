import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';
import { scanArtifact } from '../../../../infra/release-scan/detect/index.ts';
import type { ScanResult } from '../../../../infra/release-scan/detect/index.ts';
import { realManifest, writeZip } from '../detect/fixtures.ts';
import type { ZipFile } from '../detect/fixtures.ts';

// 只由编排者在隔离容器里运行；制品在仓库 .tmp 内现场生成并清理。
const root = fileURLToPath(new URL('../../../../.tmp/QA-09f/', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export async function scan(ext: 'apk' | 'aab' | 'ipa', files: readonly ZipFile[]) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'artifact-'));
  dirs.push(dir);
  return scanArtifact({
    path: writeZip(dir, `fixture.${ext}`, files),
    platform: ext === 'ipa' ? 'ios' : 'android',
    manifestYaml: realManifest(),
    approvals: [],
  });
}

export function expectClean(result: ScanResult): void {
  expect(result.errors).toEqual([]);
  expect(result.hits).toEqual([]);
  expect(result.exit_code).toBe(0);
  expect(result.passed).toBe(true);
}

export function expectMaterial(result: ScanResult, file: string, value: string): void {
  expect(result.errors).toEqual([]);
  expect(result.exit_code).toBe(1);
  expect(result.passed).toBe(false);
  expect(result.hits).toContainEqual({
    rule: 'request-sign-material',
    file,
    line: expect.any(Number),
    match: value,
    never_accepted: true,
  });
  expect(result.report.decisions).toContainEqual(
    expect.objectContaining({
      hit: expect.objectContaining({
        rule: 'request-sign-material',
        file,
        match: value,
        never_accepted: true,
      }),
      verdict: 'block',
      reason: 'never_accepted',
    }),
  );
}
