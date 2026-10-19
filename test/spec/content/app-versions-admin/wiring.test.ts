import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { textSpecsSource } from '../../../../apps/api/src/modules/content/specs/scripts/generate-text-specs.ts';

const root = new URL('../../../../', import.meta.url);

it('[AC-F1-02zc#23] 三个操作去掉 planned，公开契约保留操作标识', () => {
  const source = readFileSync(new URL('contracts/openapi.yaml', root), 'utf8');
  for (const operation of ['adminListAppVersions', 'adminGetAppVersion', 'adminSaveAppVersion']) {
    const start = source.indexOf(`      operationId: ${operation}\n`);
    expect(start).toBeGreaterThan(0);
    const tail = source.slice(start + 1);
    const next = tail.search(/^  \/|^    (get|put|post|delete|patch):/m);
    const block = next < 0 ? tail : tail.slice(0, next);
    expect(block).not.toContain('x-implementation: planned');
  }
});

it('[AC-F1-02zc#24] 商店快照由唯一 YAML 生成，两个既有 kind 输出逐字节不变', async () => {
  const output = new URL('apps/api/src/modules/content/specs/app-stores.gen.ts', root);
  expect(existsSync(output), 'Y5 requires the generated store table').toBe(true);
  const file = new URL('specs/app-stores.yaml', root);
  // Widening TextSpecKind is implementation work; the call remains type-safe after that change.
  const source = await textSpecsSource(file, 'app-stores' as Parameters<typeof textSpecsSource>[1]);
  expect(readFileSync(output, 'utf8')).toBe(source);
  const data = /export const APP_STORES\s*=\s*([\s\S]*?)\s+as const;/.exec(source);
  expect(data).not.toBeNull();
  expect(JSON.parse(data![1]!)).toEqual(parseYamlLite(readFileSync(file, 'utf8')));
  expect(source).not.toMatch(/^\s*import\s/m);
  for (const kind of ['banned-words', 'fund-term-keys'] as const) {
    expect(await textSpecsSource(new URL(`specs/${kind}.yaml`, root), kind)).toBe(
      readFileSync(new URL(`apps/api/src/modules/content/specs/${kind}.gen.ts`, root), 'utf8'),
    );
  }
});
