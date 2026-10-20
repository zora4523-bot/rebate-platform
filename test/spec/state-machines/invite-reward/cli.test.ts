import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { readRequired, repoFile } from '../order/kit.ts';
import { GENERATED, SOURCE } from './kit.ts';

async function fixture(): Promise<string> {
  // 所有缺失资产先通过断言报错，不让文件操作产生 ENOENT；只在隔离容器中运行。
  readRequired(SOURCE);
  expect(MACHINES).toContain('invite-reward');
  const assets = MACHINES.flatMap((name) => [
    `specs/state-machines/${name}.yaml`,
    `packages/domain/src/state-machines/${name}.gen.ts`,
  ]).map((path) => ({ path, text: readRequired(path) }));
  const parent = fileURLToPath(repoFile('.tmp/B1-35a/'));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'generator-'));
  try {
    await mkdir(join(root, 'specs/state-machines'), { recursive: true });
    await mkdir(join(root, 'packages/domain/src/state-machines'), { recursive: true });
    await mkdir(join(root, 'tools/lib'), { recursive: true });
    await cp(repoFile('packages/domain/scripts'), join(root, 'packages/domain/scripts'), {
      recursive: true,
    });
    await cp(repoFile('tools/lib/yaml-lite.ts'), join(root, 'tools/lib/yaml-lite.ts'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    for (const { path, text } of assets) await writeFile(join(root, path), text);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function run(root: string, verify: boolean): number | null {
  const child = spawnSync(
    process.execPath,
    [join(root, 'packages/domain/scripts/state-machines.ts'), ...(verify ? ['--verify'] : [])],
    { cwd: root, encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).not.toBeNull();
  return child.status;
}

// 校验全部夹具文件的内容、修改时刻和文件清单，捕获 --verify 偷写或修复其他机器。
async function snapshot(root: string): Promise<Record<string, { text: string; mtimeMs: number }>> {
  const files: Record<string, { text: string; mtimeMs: number }> = {};
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        files[path] = {
          text: await readFile(join(root, path), 'utf8'),
          mtimeMs: (await stat(join(root, path))).mtimeMs,
        };
      }
    }
  }
  await visit('');
  return files;
}

it('[AC-B1-35a#8] 当前全部生成物 --verify 退出 0，不改任何夹具文件', async () => {
  const root = await fixture();
  try {
    const before = await snapshot(root);
    expect(run(root, true)).toBe(0);
    expect(await snapshot(root)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['source-changed', 'missing', 'stale'])(
  '[AC-B1-35a#8] invite-reward %s 时 --verify 退出 1 且不修复，正常生成后恢复',
  async (mode) => {
    const root = await fixture();
    try {
      expect(run(root, true)).toBe(0);
      let yaml = readRequired(SOURCE);
      if (mode === 'source-changed') {
        const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/m, "$1 'fixture changed guard'");
        expect(changed).not.toBe(yaml);
        yaml = changed;
        await writeFile(join(root, SOURCE), yaml);
      } else if (mode === 'missing') {
        await rm(join(root, GENERATED));
      } else {
        await writeFile(join(root, GENERATED), '// deliberately stale invite-reward fixture\n');
      }
      const before = await snapshot(root);
      expect(run(root, true)).toBe(1);
      expect(await snapshot(root)).toEqual(before);
      expect(run(root, false)).toBe(0);
      expect(existsSync(join(root, GENERATED))).toBe(true);
      expect(await readFile(join(root, GENERATED), 'utf8')).toBe(renderStateMachine(yaml));
      expect(await readFile(join(root, SOURCE), 'utf8')).toBe(yaml);
      const regenerated = await snapshot(root);
      expect(run(root, true)).toBe(0);
      expect(await snapshot(root)).toEqual(regenerated);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
