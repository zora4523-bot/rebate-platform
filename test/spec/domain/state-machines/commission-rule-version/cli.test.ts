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
  // 先断言资产存在，不能把缺文件的 ENOENT 当有效先红。
  const sources = MACHINES.map((name) => ({
    source: `specs/state-machines/${name}.yaml`,
    yaml: readRequired(`specs/state-machines/${name}.yaml`),
    target: `packages/domain/src/state-machines/${name}.gen.ts`,
    generated: readRequired(`packages/domain/src/state-machines/${name}.gen.ts`),
  }));
  const parent = fileURLToPath(repoFile('.tmp/B2-03j/'));
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

it('[AC-B2-03j#11] --verify 接受与 YAML 一致的生成物且不改源文件或生成物', async () => {
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
  '[AC-B2-03j#12] %s 使 --verify 失败且不修复，正常生成后再次通过',
  async (scenario) => {
    const root = await fixture();
    try {
      const target = join(root, TARGET);
      const original = readRequired(TARGET);
      const stale = '// stale commission-rule-version fixture\n';
      if (scenario === '过期生成物') await writeFile(target, stale);
      if (scenario === '缺失生成物') await rm(target);
      const yaml =
        scenario === 'YAML 守卫变更'
          ? readRequired(SOURCE).replaceAll('BR-CALC-22', 'BR-CALC-22（夹具文字变更）')
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
        expect(regenerated).toContain('BR-CALC-22（夹具文字变更）');
      } else {
        expect(regenerated).toBe(original);
      }
      expect(run(root, true)).toBe(0);
      for (const name of MACHINES.filter((candidate) => String(candidate) !== NAME)) {
        const path = `packages/domain/src/state-machines/${name}.gen.ts`;
        expect(await readFile(join(root, path), 'utf8')).toBe(readRequired(path));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
