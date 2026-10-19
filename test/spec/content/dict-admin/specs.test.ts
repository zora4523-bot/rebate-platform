import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { textSpecsSource } from '../../../../apps/api/src/modules/content/specs/scripts/generate-text-specs.ts';

it('[AC-F1-02t#9] 两份文本规格快照可重现且包含 YAML 全部字段，运行时不读 YAML', async () => {
  const root = new URL('../../../../', import.meta.url);
  for (const [kind, exportName] of [
    ['banned-words', 'BANNED_WORDS'],
    ['fund-term-keys', 'FUND_TERM_KEYS'],
  ] as const) {
    const input = new URL(`specs/${kind}.yaml`, root);
    // Stub throws NotImplemented before any absent generated file can cause ENOENT.
    const source = await textSpecsSource(input, kind);
    const output = new URL(`apps/api/src/modules/content/specs/${kind}.gen.ts`, root);
    expect(existsSync(output), `${kind} snapshot must be generated`).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe(source);
    const match = new RegExp(`export const ${exportName}\\s*=\\s*([\\s\\S]*?)\\s+as const;`).exec(
      source,
    );
    expect(match, `${exportName} must be a plain data constant`).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(parseYamlLite(readFileSync(input, 'utf8')));
    expect(source).not.toMatch(/^\s*import\s/m);
  }
});
