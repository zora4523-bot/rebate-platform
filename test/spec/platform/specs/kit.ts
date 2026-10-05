import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

export function sourceFile(name: string): URL {
  return new URL(`../../../../specs/${name}.yaml`, import.meta.url);
}

export function generatedFile(name: string): URL {
  return new URL(`../../../../apps/api/src/modules/platform/specs/${name}.gen.ts`, import.meta.url);
}

export async function readSource(name: string): Promise<unknown> {
  // Independent oracle: never import the generator's YAML parsing or validation code.
  return parseYamlLite(await readFile(sourceFile(name), 'utf8'));
}

export async function readGenerated(name: string): Promise<string> {
  const file = generatedFile(name);
  // Missing artifacts must fail an assertion, not module resolution or ENOENT.
  expect(existsSync(file), `${name}.gen.ts must be checked in`).toBe(true);
  return readFile(file, 'utf8');
}

/** Evaluate only the generated constant module, with no require, filesystem or application. */
export function generatedValue(source: string, exportName: string): unknown {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics ?? []).toEqual([]);
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled.outputText, { exports }, { timeout: 1000 });
  expect(Object.hasOwn(exports, exportName), `missing generated export ${exportName}`).toBe(true);
  // Remove VM realm prototypes while retaining value types, order and undefined fields.
  return structuredClone(exports[exportName]);
}

export async function renderFixture(
  render: (inputFile: URL) => Promise<string>,
  yaml: string,
): Promise<string> {
  const root = fileURLToPath(new URL('../../../../.tmp/CT-15m/', import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'spec-'));
  try {
    const input = join(dir, 'fixture.yaml');
    await writeFile(input, yaml);
    return await render(pathToFileURL(input));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function platformExports(): Promise<Record<string, unknown>> {
  // As in other platform rule tests, avoid type-checking Nest decorators with test/tsconfig.
  const file = new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url);
  return (await import(/* @vite-ignore */ file.href)) as Record<string, unknown>;
}
