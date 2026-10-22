import * as domain from '@couli/domain';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, repoFile, type Machine } from '../order/kit.ts';

export { generatedExports, readRequired } from '../order/kit.ts';
export type Name = 'pay-order' | 'pay-refund';
export type Transition = (from: string | null, event: string) => unknown;

export interface ExpectedRow {
  id: string;
  from: string | null;
  event: string;
  guardPoints: string[];
  to: string;
  testId: string;
}

// 独立盲录依据：SPEC_REF eabcf007，BR-PAY-02/04/05/06。
// 事件编码及 SM-PAY 编号采用 CT-21d 编排补充；不从 YAML 或生成物推导期望。
// 守卫仅检查说明文字；CAS、20902、分录、队列等执行行为属于 B2-15b～e。
export function expectedRows(name: Name): ExpectedRow[] {
  const text = readRequired(`test/spec/state-machines/${name}/expected.csv`);
  const [header, ...lines] = text.trim().split(/\r?\n/);
  expect(header).toBe('id,from,event,guard_points,to,test_id');
  return lines.map((line) => {
    const cells = line.split(',');
    expect(cells).toHaveLength(6);
    const [id, from, event, guard, to, testId] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      id,
      from: from === 'null' ? null : from,
      event,
      guardPoints: guard.split(';'),
      to,
      testId,
    };
  });
}

export function sourcePath(name: Name): string {
  return `specs/state-machines/${name}.yaml`;
}

export function generatedPath(name: Name): string {
  return `packages/domain/src/state-machines/${name}.gen.ts`;
}

export function machine(name: Name): Machine {
  const parsed = parseYamlLite(readRequired(sourcePath(name)));
  expect(parsed).toEqual(
    expect.objectContaining({
      name: expect.any(String),
      field: expect.any(String),
      states: expect.any(Array),
      events: expect.any(Array),
      transitions: expect.any(Array),
    }),
  );
  return parsed as Machine;
}

export const ENTRIES = ['public', 'generated'] as const;

export function exportsOf(name: Name, entry: (typeof ENTRIES)[number]): Record<string, unknown> {
  return entry === 'public' ? domain : generatedExports(readRequired(generatedPath(name)));
}

export function transitionOf(name: Name, entry: (typeof ENTRIES)[number]): Transition {
  const key = name === 'pay-order' ? 'transitionPayOrder' : 'transitionPayRefund';
  const exported = exportsOf(name, entry)[key];
  // 采用已有提现测试的入口存在性断言，避免缺少生成物造成导入错误或 TypeError。
  expect(exported, `${entry} 必须导出 ${key}`).toEqual(expect.any(Function));
  return exported as Transition;
}

export function matrix(states: readonly string[], events: readonly string[]) {
  return ENTRIES.flatMap((entry) =>
    [null, ...states].flatMap((from) => events.map((event) => ({ entry, from, event }))),
  );
}

// 仅由容器里的规则测试调用，不在 Codex 宿主执行；夹具只包含当前状态机。
export async function verifyCli(name: Name): Promise<void> {
  const yaml = readRequired(sourcePath(name));
  const generated = readRequired(generatedPath(name));
  const parent = fileURLToPath(repoFile('.tmp/CT-21d/'));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, `${name}-`));
  try {
    await mkdir(join(root, 'specs/state-machines'), { recursive: true });
    await mkdir(join(root, 'packages/domain/src/state-machines'), { recursive: true });
    await mkdir(join(root, 'tools/lib'), { recursive: true });
    await cp(repoFile('packages/domain/scripts'), join(root, 'packages/domain/scripts'), {
      recursive: true,
    });
    await cp(repoFile('tools/lib/yaml-lite.ts'), join(root, 'tools/lib/yaml-lite.ts'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(root, sourcePath(name)), yaml);
    const target = join(root, generatedPath(name));
    await writeFile(target, generated);
    const run = () => {
      const child = spawnSync(
        process.execPath,
        ['packages/domain/scripts/state-machines.ts', '--verify'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      return child.status;
    };
    expect(run()).toBe(0);
    expect(await readFile(target, 'utf8')).toBe(generated);
    const stale = `${generated}\n// stale fixture\n`;
    await writeFile(target, stale);
    expect(run()).toBe(1);
    expect(await readFile(target, 'utf8')).toBe(stale);
    expect(await readFile(join(root, sourcePath(name)), 'utf8')).toBe(yaml);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
