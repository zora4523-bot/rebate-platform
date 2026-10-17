import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { renderStateMachine } from '../../../../packages/domain/scripts/state-machines.ts';
import { repoFile, yamlText, type MachineName } from './kit.ts';

async function fixture(): Promise<string> {
  // 先断言输入资产存在，避免先红变成 cp/readFile 的路径错误。
  const platform = yamlText('order-platform');
  const rebate = yamlText('order-rebate');
  const parent = fileURLToPath(repoFile('.tmp/CT-04a/'));
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
    await writeFile(join(root, 'specs/state-machines/order-platform.yaml'), platform);
    await writeFile(join(root, 'specs/state-machines/order-rebate.yaml'), rebate);
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

function output(root: string, name: MachineName): string {
  return join(root, `packages/domain/src/state-machines/${name}.gen.ts`);
}

it('[AC-CT-04a-CLI#1] 无参数命令生成两份文件，随后 --verify 成功且不改文本', async () => {
  const root = await fixture();
  try {
    expect(run(root, false)).toBe(0);
    for (const name of ['order-platform', 'order-rebate'] as const) {
      const expected = renderStateMachine(yamlText(name));
      expect(await readFile(output(root, name), 'utf8')).toBe(expected);
    }
    expect(run(root, true)).toBe(0);
    for (const name of ['order-platform', 'order-rebate'] as const) {
      expect(await readFile(output(root, name), 'utf8')).toBe(renderStateMachine(yamlText(name)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['order-platform', 'order-rebate'] as const)(
  '[AC-CT-04a-CLI#2] %s 过期时 --verify 非零退出且不修复，生成命令可修复',
  async (name) => {
    const root = await fixture();
    try {
      for (const item of ['order-platform', 'order-rebate'] as const) {
        await writeFile(output(root, item), renderStateMachine(yamlText(item)));
      }
      const stale = '// deliberately stale fixture\n';
      await writeFile(output(root, name), stale);
      expect(run(root, true)).not.toBe(0);
      expect(await readFile(output(root, name), 'utf8')).toBe(stale);
      const other = name === 'order-platform' ? 'order-rebate' : 'order-platform';
      expect(await readFile(output(root, other), 'utf8')).toBe(renderStateMachine(yamlText(other)));
      expect(run(root, false)).toBe(0);
      expect(await readFile(output(root, name), 'utf8')).toBe(renderStateMachine(yamlText(name)));
      expect(run(root, true)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
