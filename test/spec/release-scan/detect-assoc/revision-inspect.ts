import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';
import { artifactTextViews } from '../../../../infra/release-scan/detect/association.ts';
import { readArtifact, scanArtifact } from '../../../../infra/release-scan/detect/index.ts';
import { realManifest, writeZip } from '../detect/fixtures.ts';
import type { ZipFile } from '../detect/fixtures.ts';

// 本轮新增资产遵循根 AGENTS.md：临时制品只写仓库 .tmp，容器执行后清理。
const root = fileURLToPath(new URL('../../../../.tmp/QA-09d-revision/', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export async function inspectRevision(ext: 'apk' | 'aab' | 'hap', files: readonly ZipFile[]) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'artifact-'));
  dirs.push(dir);
  const path = writeZip(dir, `fixture.${ext}`, files);
  const read = await readArtifact(path);
  expect(read.errors).toEqual([]);
  // 所有补充用例必须通过现有 NotImplemented 关联入口，先红不依赖模块缺失。
  const associated = artifactTextViews(read.entries);
  const scan = await scanArtifact({
    path,
    platform: ext === 'hap' ? 'harmony' : 'android',
    manifestYaml: realManifest(),
    approvals: [],
  });
  return { associated, scan };
}
