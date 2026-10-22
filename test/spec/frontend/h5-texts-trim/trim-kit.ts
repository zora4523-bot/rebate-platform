import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'vite';
import { expect } from 'vitest';
import { collectH5Texts, type TrimTextDictionary } from '../../../../apps/h5/build/trim-texts.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const SOURCE_ROOT = fileURLToPath(new URL('apps/h5/src/', ROOT));
export type Entry = 'app' | 'landing' | 'conformance';

export function contractDictionary(): TrimTextDictionary {
  return JSON.parse(
    readFileSync(new URL('contracts/texts.default.json', ROOT), 'utf8'),
  ) as TrimTextDictionary;
}

// Native AI conversation, app-update and withdrawal-confirmation copy: no H5 source references these keys or
// dynamic prefixes (the existing dynamic families are ledger_type / claim / error).
// Use long, distinctive values so unrelated copy such as 「重试」 cannot cause false positives.
export const UNREFERENCED = [
  'agent.welcome',
  'agent.refuse.advice',
  'app_update.unavailable',
  'pending_confirm.withdraw.desc',
] as const;

export function assertPruned(code: string, dictionary = contractDictionary()): void {
  for (const key of UNREFERENCED) {
    const value = dictionary.texts[key];
    expect(value, `contract sentinel ${key}`).toBeTypeOf('string');
    expect(value!.length).toBeGreaterThan(12);
    expect(code, `unreferenced key ${key}`).not.toContain(key);
    expect(code, `unreferenced value ${key}`).not.toContain(value!);
    const fallback = dictionary.fallbacks[key];
    if (fallback !== undefined) {
      expect(code, `unreferenced fallback ${key}`).not.toContain(fallback);
    }
  }
}

export async function bundle(entry: Entry, overrides: InlineConfig = {}) {
  const result = await build({
    configFile: fileURLToPath(new URL('apps/h5/vite.config.ts', ROOT)),
    mode: entry,
    logLevel: 'silent',
    envFile: false,
    ...overrides,
    build: { ...overrides.build, write: false },
  });
  expect(Array.isArray(result)).toBe(false);
  expect('output' in result).toBe(true);
  if (!('output' in result)) throw new Error('unreachable after output assertion');
  // Chosen inspection seam: the production plugin emits the actual replacement object as a
  // readable asset. Compare both maps, not just a few sample keys, with the unit-tested collector.
  // All entries use the entire src collection; conformance may tree-shake the JS dictionary.
  const manifests = result.output.filter(
    (item) => item.type === 'asset' && item.fileName === 'trim-texts.json',
  );
  expect(manifests, 'plugin must expose its replacement dictionary').toHaveLength(1);
  const manifest = manifests[0]!;
  if (manifest.type !== 'asset') throw new Error('unreachable after asset assertion');
  const dictionary = JSON.parse(
    typeof manifest.source === 'string'
      ? manifest.source
      : new TextDecoder().decode(manifest.source),
  ) as TrimTextDictionary;
  expect(dictionary).toEqual(
    collectH5Texts({ sourceRoot: SOURCE_ROOT, dictionary: contractDictionary() }),
  );
  const chunks = result.output.filter((item) => item.type === 'chunk');
  expect(chunks.length).toBeGreaterThan(0);
  // Vite may escape non-ASCII literals. Decode escapes only for the content assertions;
  // size comparisons always use the original bytes.
  const code = chunks
    .map((chunk) => chunk.code)
    .join('\n')
    .replace(/\\u([\da-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return { chunks, code, dictionary };
}
