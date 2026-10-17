import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { renderStateMachine } from '../../../../packages/domain/scripts/state-machines.ts';
import { GENERATED, SOURCE, readRequired, repoFile, yamlText } from './kit.ts';

const NAMES = ['order-platform', 'order-rebate', 'withdrawal'];

async function fixture(): Promise<string> {
  // 先红在这里断言缺少输入，不能让 cp / readFile 抛 ENOENT。
  yamlText();
  const sources = NAMES.map((name) => ({
    name,
    text: readRequired(`specs/state-machines/${name}.yaml`),
  }));
  const parent = fileURLToPath(repoFile('.tmp/CT-04d/'));
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
    for (const source of sources) {
      await writeFile(join(root, `specs/state-machines/${source.name}.yaml`), source.text);
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

async function output(root: string): Promise<string> {
  expect(existsSync(join(root, GENERATED)), 'CLI 必须实际写出提现生成物').toBe(true);
  return readFile(join(root, GENERATED), 'utf8');
}

async function seed(root: string): Promise<void> {
  for (const name of NAMES) {
    await writeFile(
      join(root, `packages/domain/src/state-machines/${name}.gen.ts`),
      renderStateMachine(readRequired(`specs/state-machines/${name}.yaml`)),
    );
  }
}

it('[AC-CT-04d#12] 无参数 CLI 包含提现，随后 --verify 成功且不改文件', async () => {
  const root = await fixture();
  try {
    expect(run(root, false)).toBe(0);
    const expected = renderStateMachine(yamlText());
    expect(await output(root)).toBe(expected);
    expect(run(root, true)).toBe(0);
    expect(await output(root)).toBe(expected);
    expect(await readFile(join(root, SOURCE), 'utf8')).toBe(yamlText());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['stale', 'missing', 'source-changed'])(
  '[AC-CT-04d#13] 提现 %s 时 --verify 失败、不修复，生成后恢复一致',
  async (mode) => {
    const root = await fixture();
    try {
      await seed(root);
      let yaml = yamlText();
      let before: string | null = renderStateMachine(yaml);
      if (mode === 'stale') {
        before = '// deliberately stale withdrawal fixture\n';
        await writeFile(join(root, GENERATED), before);
      } else if (mode === 'missing') {
        before = null;
        await rm(join(root, GENERATED));
      } else {
        const changed = yaml.replace(/to: PENDING_REVIEW\b/, 'to: APPROVED');
        expect(changed).not.toBe(yaml);
        yaml = changed;
        await writeFile(join(root, SOURCE), yaml);
      }
      expect(run(root, true)).toBe(1);
      if (before === null) expect(existsSync(join(root, GENERATED))).toBe(false);
      else expect(await output(root)).toBe(before);
      expect(await readFile(join(root, SOURCE), 'utf8')).toBe(yaml);
      for (const name of ['order-platform', 'order-rebate']) {
        expect(
          await readFile(join(root, `packages/domain/src/state-machines/${name}.gen.ts`), 'utf8'),
        ).toBe(renderStateMachine(readRequired(`specs/state-machines/${name}.yaml`)));
      }
      expect(run(root, false)).toBe(0);
      expect(await output(root)).toBe(renderStateMachine(yaml));
      expect(run(root, true)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
