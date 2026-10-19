// Build-time only. Run from the repository root with:
// node apps/api/src/modules/content/specs/scripts/generate-text-specs.ts            (write)
// node apps/api/src/modules/content/specs/scripts/generate-text-specs.ts --verify   (check only)
// Writes ../banned-words.gen.ts (BANNED_WORDS) from specs/banned-words.yaml and
// ../fund-term-keys.gen.ts (FUND_TERM_KEYS) from specs/fund-term-keys.yaml, keeping every field
// and the order of lists (F1-02t, L28 / L50). The structural rules of the specifications are
// checked by packages/contracts-ts/scripts; here only the shape the runtime types promise is
// checked. Runtime code reads the generated constants and never loads YAML. Rerun after changing
// either specification; --verify exits 1 when a generated file is stale.
// F1-02zc (Y5) adds ../app-stores.gen.ts (APP_STORES) from specs/app-stores.yaml, the store table
// whose non-null keys the console's app-version save checks per platform and channel; the two
// text kinds above are rendered exactly as before.
// Deliberately independent of platform/specs/scripts (no cross-module build-time imports).
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@readme/openapi-parser';

export type TextSpecKind = 'banned-words' | 'fund-term-keys' | 'app-stores';

const SPEC_ROOT = new URL('../../../../../../../specs/', import.meta.url);
const GEN_ROOT = new URL('../', import.meta.url);

const EXPORT_NAMES: Readonly<Record<TextSpecKind, string>> = {
  'banned-words': 'BANNED_WORDS',
  'fund-term-keys': 'FUND_TERM_KEYS',
  'app-stores': 'APP_STORES',
};

const SCOPES = new Set(['user_visible', 'admin_report']);

export function textSpecFile(kind: TextSpecKind): URL {
  return new URL(`${kind}.yaml`, SPEC_ROOT);
}

export function textSpecGenFile(kind: TextSpecKind): URL {
  return new URL(`${kind}.gen.ts`, GEN_ROOT);
}

function fail(file: URL, message: string): never {
  throw new Error(`${fileURLToPath(file)}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkBannedWords(file: URL, spec: Record<string, unknown>): void {
  if (typeof spec['version'] !== 'string') fail(file, 'version must be a string');
  const words = spec['words'];
  if (!Array.isArray(words)) fail(file, 'words must be a list');
  words.forEach((word: unknown, index) => {
    const at = `words[${String(index)}]`;
    if (
      !isRecord(word) ||
      typeof word['word'] !== 'string' ||
      word['word'].length === 0 ||
      typeof word['category'] !== 'string' ||
      !isStringList(word['scopes']) ||
      !word['scopes'].every((scope) => SCOPES.has(scope))
    ) {
      fail(file, `${at} must be {word, category, scopes: [user_visible|admin_report]}`);
    }
    for (const list of ['allow_keys', 'allow_rendered_in'] as const) {
      if (word[list] !== undefined && !isStringList(word[list])) {
        fail(file, `${at}.${list} must be a list of strings`);
      }
    }
    const articles = word['allow_articles'];
    if (
      articles !== undefined &&
      !(
        Array.isArray(articles) &&
        articles.every(
          (rule: unknown) =>
            isRecord(rule) &&
            typeof rule['config_key'] === 'string' &&
            isStringList(rule['fields']),
        )
      )
    ) {
      fail(file, `${at}.allow_articles must be a list of {config_key, fields}`);
    }
  });
}

function checkFundTermKeys(file: URL, spec: Record<string, unknown>): void {
  for (const name of ['fund_terms', 'ordinary'] as const) {
    const segment = spec[name];
    if (
      !isRecord(segment) ||
      !isStringList(segment['prefixes']) ||
      !isStringList(segment['keys']) ||
      !isStringList(segment['notify_templates'])
    ) {
      fail(file, `${name} must be {prefixes, keys, notify_templates} lists of strings`);
    }
  }
  const exempt = spec['exempt'];
  if (
    !Array.isArray(exempt) ||
    !exempt.every(
      (entry: unknown) =>
        isRecord(entry) && typeof entry['key'] === 'string' && typeof entry['reason'] === 'string',
    )
  ) {
    fail(file, 'exempt must be a list of {key, reason}');
  }
}

function checkAppStores(file: URL, spec: Record<string, unknown>): void {
  if (typeof spec['version'] !== 'string') fail(file, 'version must be a string');
  const stores = spec['stores'];
  if (!Array.isArray(stores)) fail(file, 'stores must be a list');
  stores.forEach((store: unknown, index) => {
    if (
      !isRecord(store) ||
      !(store['key'] === null || typeof store['key'] === 'string') ||
      typeof store['platform'] !== 'string' ||
      !isStringList(store['channels'])
    ) {
      fail(file, `stores[${String(index)}] must be {key: string | null, platform, channels}`);
    }
  });
}

/**
 * Build-time renderer: read the supplied YAML file and emit the generated module source, which
 * exports BANNED_WORDS, FUND_TERM_KEYS or APP_STORES as plain data with no imports. An explicit input lets
 * rule tests use synthetic specifications.
 */
export async function textSpecsSource(inputFile: URL, kind: TextSpecKind): Promise<string> {
  const value: unknown = await parse(fileURLToPath(inputFile));
  if (!isRecord(value)) fail(inputFile, 'top level must be a mapping');
  if (kind === 'banned-words') checkBannedWords(inputFile, value);
  else if (kind === 'app-stores') checkAppStores(inputFile, value);
  else checkFundTermKeys(inputFile, value);
  return (
    `// Generated from specs/${kind}.yaml by content/specs/scripts/generate-text-specs.ts.\n` +
    '// Do not edit by hand. Regenerate after changing the specification.\n' +
    `export const ${EXPORT_NAMES[kind]} = ${JSON.stringify(value, null, 2)} as const;\n`
  );
}

async function main(verify: boolean): Promise<number> {
  let stale = 0;
  for (const kind of Object.keys(EXPORT_NAMES) as TextSpecKind[]) {
    const source = await textSpecsSource(textSpecFile(kind), kind);
    const output = textSpecGenFile(kind);
    if (!verify) {
      await writeFile(output, source);
      continue;
    }
    const current = await readFile(output, 'utf8').catch(() => undefined);
    if (current !== source) {
      stale += 1;
      process.stderr.write(`${fileURLToPath(output)} is stale; rerun without --verify\n`);
    }
  }
  return stale === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.includes('--verify'));
}
