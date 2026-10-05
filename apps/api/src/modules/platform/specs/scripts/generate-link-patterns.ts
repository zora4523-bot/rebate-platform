// Build-time only. Run from the repository root with:
// node apps/api/src/modules/platform/specs/scripts/generate-link-patterns.ts
// Writes ../link-patterns.gen.ts (LINK_PATTERNS) from specs/link-patterns.yaml, keeping every
// field, the version string and the order of rules, hosts and path patterns. The structural rules
// of the specification are checked by packages/contracts-ts/scripts/link-patterns.ts; here only the
// shape the runtime type promises is checked. Rerun after changing the specification; the rule
// tests fail until the generated file matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isRecord, parseSpecYaml, renderModule } from './shared.ts';

export const linkPatternsSpecFile = new URL(
  '../../../../../../../specs/link-patterns.yaml',
  import.meta.url,
);
export const linkPatternsGenFile = new URL('../link-patterns.gen.ts', import.meta.url);

const CATEGORIES = new Set(['product', 'promo', 'union_host']);

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Build-time renderer: read the supplied YAML file and emit link-patterns.gen.ts source,
 * exporting LINK_PATTERNS. An explicit input lets rule tests use synthetic specifications.
 */
export async function linkPatternsSource(inputFile: URL): Promise<string> {
  const spec = await parseSpecYaml(inputFile);
  if (typeof spec['version'] !== 'string') fail(inputFile, 'version must be a string');
  const rules = spec['rules'];
  if (!Array.isArray(rules)) fail(inputFile, 'rules must be a list');
  rules.forEach((rule: unknown, index) => {
    if (
      !isRecord(rule) ||
      typeof rule['platform'] !== 'string' ||
      typeof rule['category'] !== 'string' ||
      !CATEGORIES.has(rule['category']) ||
      !isStringList(rule['hosts']) ||
      !isStringList(rule['path_patterns'])
    ) {
      fail(inputFile, `rules[${String(index)}] must be {platform, category, hosts, path_patterns}`);
    }
  });
  return renderModule({
    source: 'specs/link-patterns.yaml',
    script: 'generate-link-patterns.ts',
    exportName: 'LINK_PATTERNS',
    value: spec,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(linkPatternsGenFile, await linkPatternsSource(linkPatternsSpecFile));
}
