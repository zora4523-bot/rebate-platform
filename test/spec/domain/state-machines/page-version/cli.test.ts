import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { MACHINES } from '../../../../../packages/domain/scripts/state-machines.ts';
import { readRequired, repoFile } from '../../../state-machines/order/kit.ts';
import { NAME, SOURCE, TARGET } from './kit.ts';

async function fixture(): Promise<string> {
  expect(MACHINES).toContain(NAME);
  // 在建夹具或启动子进程前断言资产存在，缺实现时不能以 ENOENT 报红。
  const sources = MACHINES.map((name) => ({
    source: `specs/state-machines/${name}.yaml`,
    yaml: readRequired(`specs/state-machines/${name}.yaml`),
    target: `packages/domain/src/state-machines/${name}.gen.ts`,
    generated: readRequired(`packages/domain/src/state-machines/${name}.gen.ts`),
  }));
  const parent = fileURLToPath(repoFile('.tmp/F1-09h/'));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'generator-'));
  try {
    for (const directory of [
      'specs/state-machines',
      'packages/domain/src/state-machines',
      'packages/domain/scripts',
      'tools/lib',
    ]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const path of ['packages/domain/scripts/state-machines.ts', 'tools/lib/yaml-lite.ts']) {
      await cp(repoFile(path), join(root, path));
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    for (const item of sources) {
      await writeFile(join(root, item.source), item.yaml);
      await writeFile(join(root, item.target), item.generated);
    }
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

it('[AC-F1-09h#11] --verify 接受一致的生成物，且所有源文件和生成物保持不变', async () => {
  const root = await fixture();
  try {
    expect(run(root, true)).toBe(0);
    for (const name of MACHINES) {
      for (const path of [
        `specs/state-machines/${name}.yaml`,
        `packages/domain/src/state-machines/${name}.gen.ts`,
      ]) {
        expect(await readFile(join(root, path), 'utf8')).toBe(readRequired(path));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['过期生成物', '缺失生成物', 'YAML 守卫变更'])(
  '[AC-F1-09h#12] %s 使 --verify 失败且不修复，重新生成后通过且其他状态机不变',
  async (scenario) => {
    const root = await fixture();
    try {
      const target = join(root, TARGET);
      const original = readRequired(TARGET);
      const stale = '// stale page-version fixture\n';
      if (scenario === '过期生成物') await writeFile(target, stale);
      if (scenario === '缺失生成物') await rm(target);
      const yaml =
        scenario === 'YAML 守卫变更'
          ? readRequired(SOURCE).replace(/^(\s*guard:)\s*[^\r\n]+/m, "$1 'F1-09h fixture guard'")
          : readRequired(SOURCE);
      if (scenario === 'YAML 守卫变更') {
        expect(yaml).not.toBe(readRequired(SOURCE));
        await writeFile(join(root, SOURCE), yaml);
      }

      expect(run(root, true)).toBe(1);
      expect(await readFile(join(root, SOURCE), 'utf8')).toBe(yaml);
      if (scenario === '缺失生成物') {
        expect(existsSync(target)).toBe(false);
      } else {
        expect(await readFile(target, 'utf8')).toBe(scenario === '过期生成物' ? stale : original);
      }

      expect(run(root, false)).toBe(0);
      expect(existsSync(target)).toBe(true);
      const regenerated = await readFile(target, 'utf8');
      if (scenario === 'YAML 守卫变更') {
        expect(regenerated).not.toBe(original);
        expect(regenerated).toContain('F1-09h fixture guard');
      } else {
        expect(regenerated).toBe(original);
      }
      expect(run(root, true)).toBe(0);
      expect(await readFile(join(root, SOURCE), 'utf8')).toBe(yaml);
      for (const name of MACHINES.filter((candidate) => candidate !== NAME)) {
        for (const path of [
          `specs/state-machines/${name}.yaml`,
          `packages/domain/src/state-machines/${name}.gen.ts`,
        ]) {
          expect(await readFile(join(root, path), 'utf8')).toBe(readRequired(path));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
