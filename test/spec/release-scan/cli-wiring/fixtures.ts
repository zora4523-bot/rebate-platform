import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { main } from '../../../../infra/release-scan/cli.ts';
import type { CliReport } from '../../../../infra/release-scan/cli.ts';
import { realManifest, writeZip } from '../detect/fixtures.ts';
import type { ZipFile } from '../detect/fixtures.ts';

// 按 QA-09e §9 在容器测试运行时创建系统临时目录；宿主不执行这些代码。
// 只截获 CLI 输出，不替换读取、解析、关联、扫描或清单比对。
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface CliResult {
  code: number;
  report: CliReport;
  output: string;
}

export async function runCli(
  ext: 'aab' | 'hap' | 'apk' | 'ipa',
  entries: readonly ZipFile[],
  release: boolean,
  manifest = realManifest(),
): Promise<CliResult> {
  const dir = mkdtempSync(join(tmpdir(), 'QA-09e-'));
  dirs.push(dir);
  const artifact = writeZip(dir, `fixture.${ext}`, entries);
  const manifestPath = join(dir, 'ids.yaml');
  const approvalsPath = join(dir, 'approvals.yaml');
  writeFileSync(manifestPath, manifest);
  // 合成批准记录只供测试清单解析，不表示负责人授权。
  writeFileSync(approvalsPath, 'approvals:\n  - id: 30\n    granted: true\n');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  try {
    const code = await main([
      artifact,
      '--platform',
      ext === 'ipa' ? 'ios' : ext === 'hap' ? 'harmony' : 'android',
      '--manifest',
      manifestPath,
      '--approvals',
      approvalsPath,
      ...(release ? ['--release'] : []),
    ]);
    expect(stdout.join('').trim(), 'CLI 必须输出报告').not.toBe('');
    return {
      code,
      report: JSON.parse(stdout.join('')) as CliReport,
      output: stdout.join('') + stderr.join(''),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

export function expectBlocked(
  result: CliResult,
  kind: 'secret' | 'residue',
  rule: string,
  file: string,
): void {
  expect(result.code).toBe(1);
  expect(result.report).toMatchObject({ exit_code: 1, passed: false, errors: [] });
  expect(result.report.findings).toContainEqual({
    kind,
    rule,
    file,
    verdict: 'block',
    line: expect.any(Number),
  });
  for (const finding of result.report.findings) {
    expect(Number.isInteger(finding.line) && finding.line > 0).toBe(true);
  }
}

export function expectClean(result: CliResult): void {
  expect(result.code).toBe(0);
  expect(result.report).toMatchObject({ exit_code: 0, passed: true, errors: [], findings: [] });
}
